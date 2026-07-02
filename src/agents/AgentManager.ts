import { randomUUID } from "node:crypto";
import { getAgentDefinition } from "./AgentRegistry.js";
import type {
  AgentDefinition,
  AgentTask,
  AgentTaskTurn,
  AgentTaskEvent,
  SendAgentMessageInput,
  SpawnAgentInput,
  StopAgentInput,
} from "./types.js";
import type { CodingAgentPromptOptions, CodingAgentTurnResult } from "../agent.js";

type AgentRunner = {
  prompt(prompt: string, options?: CodingAgentPromptOptions): Promise<CodingAgentTurnResult>;
};

type InternalAgentTask = AgentTask & {
  runner?: AgentRunner;
  active?: Promise<void>;
  abortController: AbortController;
  definition: AgentDefinition;
};

export type AgentManagerOptions = {
  createRunner(task: AgentTask, definition: AgentDefinition): Promise<AgentRunner>;
  onEvent?: (event: AgentTaskEvent) => void | Promise<void>;
};

export class AgentManager {
  private readonly tasks = new Map<string, InternalAgentTask>();

  constructor(private readonly options: AgentManagerOptions) {}

  list(): AgentTask[] {
    return [...this.tasks.values()].map(task => this.snapshot(task));
  }

  get(id: string): AgentTask | undefined {
    const task = this.tasks.get(id);
    return task ? this.snapshot(task) : undefined;
  }

  getOrThrow(id: string): AgentTask {
    const task = this.get(id);
    if (!task) {
      throw new Error(`Unknown agent task "${id}"`);
    }
    return task;
  }

  async spawn(input: SpawnAgentInput): Promise<AgentTask> {
    const definition = getAgentDefinition(input.subagentType);
    const now = new Date().toISOString();
    const task: InternalAgentTask = {
      id: `agent_${randomUUID().slice(0, 8)}`,
      description: input.description,
      subagentType: definition.type,
      status: "queued",
      background: input.runInBackground ?? false,
      createdAt: now,
      updatedAt: now,
      prompt: input.prompt,
      pendingMessages: [input.prompt],
      turns: [],
      abortController: new AbortController(),
      definition,
    };

    this.tasks.set(task.id, task);
    await this.emit({ type: "agent_task_created", task: this.snapshot(task) });
    const active = this.ensureRunning(task);
    if (!task.background) {
      await active;
    }
    return this.snapshot(task);
  }

  async sendMessage(input: SendAgentMessageInput): Promise<AgentTask> {
    const task = this.tasks.get(input.to);
    if (!task) {
      throw new Error(`Unknown agent task "${input.to}"`);
    }
    if (task.status === "failed") {
      throw new Error(`Agent task "${input.to}" has failed and cannot receive messages.`);
    }
    if (task.status === "killed") {
      throw new Error(`Agent task "${input.to}" was stopped and cannot receive messages.`);
    }

    task.pendingMessages.push(input.message);
    task.updatedAt = new Date().toISOString();
    if (task.status === "completed") {
      task.status = "queued";
      task.error = undefined;
    }
    await this.emit({ type: "agent_task_message_queued", task: this.snapshot(task), message: input.message });

    const active = this.ensureRunning(task);
    if (input.waitForResponse) {
      await active;
    }
    return this.snapshot(task);
  }

  async stop(input: StopAgentInput): Promise<AgentTask> {
    const task = this.tasks.get(input.id);
    if (!task) {
      throw new Error(`Unknown agent task "${input.id}"`);
    }
    if (task.status !== "running" && task.status !== "queued") {
      return this.snapshot(task);
    }

    const now = new Date().toISOString();
    const message = input.reason?.trim() || "Agent task stopped.";
    task.abortController.abort(message);
    task.pendingMessages = [];
    task.status = "killed";
    task.error = message;
    task.completedAt = now;
    task.updatedAt = now;
    task.notification = this.notification(task, "killed", message);
    await this.emit({ type: "agent_task_killed", task: this.snapshot(task), message });
    await this.emit({ type: "agent_task_notification", task: this.snapshot(task), notification: task.notification });
    return this.snapshot(task);
  }

  private ensureRunning(task: InternalAgentTask): Promise<void> {
    if (task.active) {
      return task.active;
    }
    task.active = this.runLoop(task).finally(() => {
      task.active = undefined;
    });
    return task.active;
  }

  private async runLoop(task: InternalAgentTask): Promise<void> {
    try {
      task.runner ??= await this.options.createRunner(this.snapshot(task), task.definition);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.fail(task, message);
      await this.emit({ type: "agent_task_failed", task: this.snapshot(task), message });
      await this.emitNotification(task);
      return;
    }

    while (task.pendingMessages.length > 0) {
      if (task.abortController.signal.aborted || task.status === "killed") {
        return;
      }
      const prompt = task.pendingMessages.shift()!;
      const startedAt = new Date().toISOString();
      const turn: AgentTaskTurn = { prompt, startedAt };
      task.turns.push(turn);
      task.status = "running";
      task.updatedAt = startedAt;
      await this.emit({ type: "agent_task_started", task: this.snapshot(task) });

      try {
        const result = await task.runner.prompt(prompt);
        if (task.abortController.signal.aborted) {
          return;
        }
        turn.output = result.output;
        turn.finishedAt = new Date().toISOString();
        task.result = result.output;
        task.updatedAt = turn.finishedAt;
      } catch (error) {
        if (task.abortController.signal.aborted) {
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        turn.finishedAt = new Date().toISOString();
        this.fail(task, message, turn);
        await this.emit({ type: "agent_task_failed", task: this.snapshot(task), message });
        await this.emitNotification(task);
        return;
      }
    }

    if (task.abortController.signal.aborted || task.status === "killed") {
      return;
    }
    task.status = "completed";
    task.completedAt = new Date().toISOString();
    task.updatedAt = task.completedAt;
    task.notification = this.notification(task, "completed");
    await this.emit({ type: "agent_task_completed", task: this.snapshot(task) });
    await this.emitNotification(task);
  }

  private snapshot(task: InternalAgentTask): AgentTask {
    return {
      id: task.id,
      description: task.description,
      subagentType: task.subagentType,
      status: task.status,
      background: task.background,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      completedAt: task.completedAt,
      prompt: task.prompt,
      pendingMessages: [...task.pendingMessages],
      turns: task.turns.map(turn => ({ ...turn })),
      notification: task.notification,
      result: task.result,
      error: task.error,
    };
  }

  private async emit(event: AgentTaskEvent): Promise<void> {
    await this.options.onEvent?.(event);
  }

  private fail(task: InternalAgentTask, message: string, turn?: AgentTaskTurn): void {
    const now = new Date().toISOString();
    if (turn) {
      turn.error = message;
      turn.finishedAt = turn.finishedAt ?? now;
    }
    task.status = "failed";
    task.error = message;
    task.completedAt = now;
    task.updatedAt = now;
    task.notification = this.notification(task, "failed", message);
  }

  private async emitNotification(task: InternalAgentTask): Promise<void> {
    if (!task.notification) {
      return;
    }
    await this.emit({
      type: "agent_task_notification",
      task: this.snapshot(task),
      notification: task.notification,
    });
  }

  private notification(task: InternalAgentTask, status: "completed" | "failed" | "killed", message?: string): string {
    const summary = status === "completed"
      ? `Agent "${task.description}" completed.`
      : status === "failed"
        ? `Agent "${task.description}" failed: ${message ?? task.error ?? "Unknown error"}`
        : `Agent "${task.description}" was stopped: ${message ?? task.error ?? "stopped"}`;
    const result = task.result ? `\n<result>${task.result}</result>` : "";
    return [
      "<task-notification>",
      `<task-id>${task.id}</task-id>`,
      `<status>${status}</status>`,
      `<summary>${summary}</summary>${result}`,
      "</task-notification>",
    ].join("\n");
  }
}
