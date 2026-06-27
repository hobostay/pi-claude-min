import type { CodingAgentSession } from "../agent.js";
import { AgentStepExecutor } from "../executor/AgentStepExecutor.js";
import { TaskScheduler } from "../scheduler/TaskScheduler.js";
import type {
  WorkflowContext,
  WorkflowEvent,
  WorkflowRunResult,
  WorkflowStepResult,
  WorkflowTask,
} from "./types.js";

export type WorkflowEngineOptions = {
  maxPromptChars?: number;
  maxAttempts?: number;
  maxDynamicPlanItems?: number;
  onEvent?: (event: WorkflowEvent) => void | Promise<void>;
};

export class WorkflowEngine {
  readonly maxPromptChars: number;
  readonly maxDynamicPlanItems: number;

  constructor(
    readonly runner: CodingAgentSession,
    readonly options: WorkflowEngineOptions = {},
  ) {
    this.maxPromptChars = options.maxPromptChars ?? 24_000;
    this.maxDynamicPlanItems = options.maxDynamicPlanItems ?? 8;
  }

  private async emit(event: WorkflowEvent): Promise<void> {
    await this.options.onEvent?.(event);
  }

  private createContext(goal: string, results: WorkflowStepResult[]): WorkflowContext {
    const info = this.runner.info();
    return {
      goal,
      cwd: info.cwd,
      provider: info.provider,
      model: info.model,
      tools: info.tools,
      history: results,
      maxPromptChars: this.maxPromptChars,
    };
  }

  async run(goal: string): Promise<WorkflowRunResult> {
    const startedAt = new Date().toISOString();
    const info = this.runner.info();
    const scheduler = new TaskScheduler(goal, info.cwd, {
      maxAttempts: this.options.maxAttempts,
    });
    const executor = new AgentStepExecutor(this.runner);
    const results: WorkflowStepResult[] = [];

    await this.emit({ type: "workflow_started", workflowId: scheduler.plan.id, goal });

    while (scheduler.hasPendingWork()) {
      const task = scheduler.nextRunnable();
      if (!task) {
        for (const pending of scheduler.tasks.filter(item => item.status === "pending")) {
          scheduler.markSkipped(pending, "Dependencies did not complete.");
        }
        break;
      }

      scheduler.markRunning(task);
      await this.emit({ type: "workflow_task_started", workflowId: scheduler.plan.id, task: { ...task } });

      const result = await executor.execute(task, this.createContext(goal, results));
      task.result = result;
      results.push(result);

      if (result.status === "completed") {
        scheduler.markCompleted(task);
        await this.emit({ type: "workflow_task_completed", workflowId: scheduler.plan.id, task: { ...task }, result });

        if (task.kind === "plan" && result.parsed.planItems.length > 0) {
          const created = scheduler.schedulePlanItems(
            result.parsed.planItems.slice(0, this.maxDynamicPlanItems),
            task.id,
          );
          for (const newTask of created) {
            await this.emit({ type: "workflow_task_scheduled", workflowId: scheduler.plan.id, task: { ...newTask } });
          }
        }
      } else {
        scheduler.markFailed(task, result.error ?? "Step failed.");
        await this.emit({ type: "workflow_task_failed", workflowId: scheduler.plan.id, task: { ...task }, result });
      }
    }

    const runResult: WorkflowRunResult = {
      id: scheduler.plan.id,
      goal,
      status: scheduler.overallStatus(),
      tasks: scheduler.tasks.map((task: WorkflowTask) => ({ ...task })),
      results,
      startedAt,
      completedAt: new Date().toISOString(),
    };
    await this.emit({ type: "workflow_finished", workflowId: scheduler.plan.id, result: runResult });
    return runResult;
  }
}
