import { randomUUID } from "node:crypto";
import { getAgentDefinition } from "./AgentRegistry.js";
import type {
  AgentDefinition,
  AgentTask,
  AgentTaskTurn,
  AgentTaskEvent,
  SendAgentMessageInput,
  SpawnAgentInput,
} from "./types.js";
import type { CodingAgentPromptOptions, CodingAgentTurnResult } from "../agent.js";

type AgentRunner = {
  prompt(prompt: string, options?: CodingAgentPromptOptions): Promise<CodingAgentTurnResult>;
};

type InternalAgentTask = AgentTask & {
  runner?: AgentRunner;
  active?: Promise<void>;
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
    task.runner ??= await this.options.createRunner(this.snapshot(task), task.definition);

    while (task.pendingMessages.length > 0) {
      const prompt = task.pendingMessages.shift()!;
      const startedAt = new Date().toISOString();
      const turn: AgentTaskTurn = { prompt, startedAt };
      task.turns.push(turn);
      task.status = "running";
      task.updatedAt = startedAt;
      await this.emit({ type: "agent_task_started", task: this.snapshot(task) });

      try {
        const result = await task.runner.prompt(prompt);
        turn.output = result.output;
        turn.finishedAt = new Date().toISOString();
        task.result = result.output;
        task.updatedAt = turn.finishedAt;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        turn.error = message;
        turn.finishedAt = new Date().toISOString();
        task.status = "failed";
        task.error = message;
        task.updatedAt = turn.finishedAt;
        await this.emit({ type: "agent_task_failed", task: this.snapshot(task), message });
        return;
      }
    }

    task.status = "completed";
    task.updatedAt = new Date().toISOString();
    await this.emit({ type: "agent_task_completed", task: this.snapshot(task) });
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
      prompt: task.prompt,
      pendingMessages: [...task.pendingMessages],
      turns: task.turns.map(turn => ({ ...turn })),
      result: task.result,
      error: task.error,
    };
  }

  private async emit(event: AgentTaskEvent): Promise<void> {
    await this.options.onEvent?.(event);
  }
}
