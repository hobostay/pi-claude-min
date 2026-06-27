import { randomUUID } from "node:crypto";
import type { ParsedPlanItem, WorkflowPlan, WorkflowTask, WorkflowTaskKind, WorkflowTaskStatus } from "../workflow/types.js";

export type TaskSchedulerOptions = {
  maxAttempts?: number;
};

function now(): string {
  return new Date().toISOString();
}

function createTask(input: {
  kind: WorkflowTaskKind;
  title: string;
  prompt: string;
  dependencies?: string[];
  maxAttempts: number;
}): WorkflowTask {
  return {
    id: randomUUID(),
    kind: input.kind,
    title: input.title,
    prompt: input.prompt,
    status: "pending",
    dependencies: input.dependencies ?? [],
    attempts: 0,
    maxAttempts: input.maxAttempts,
    createdAt: now(),
  };
}

export class TaskScheduler {
  readonly plan: WorkflowPlan;
  readonly maxAttempts: number;

  constructor(goal: string, cwd: string, options: TaskSchedulerOptions = {}) {
    this.maxAttempts = options.maxAttempts ?? 1;
    const inspect = createTask({
      kind: "inspect",
      title: "Inspect repository context",
      prompt: "Inspect the repository structure and relevant files. Identify likely implementation areas before making changes.",
      maxAttempts: this.maxAttempts,
    });
    const plan = createTask({
      kind: "plan",
      title: "Create implementation plan",
      prompt: "Create a concise implementation plan. Return a JSON plan if extra execute steps are needed.",
      dependencies: [inspect.id],
      maxAttempts: this.maxAttempts,
    });
    const execute = createTask({
      kind: "execute",
      title: "Implement requested change",
      prompt: "Implement the requested change using the available tools. Keep edits focused and verify as you go.",
      dependencies: [plan.id],
      maxAttempts: this.maxAttempts,
    });
    const verify = createTask({
      kind: "verify",
      title: "Verify behavior",
      prompt: "Run relevant checks or explain why checks cannot be run. Fix any issues found.",
      dependencies: [execute.id],
      maxAttempts: this.maxAttempts,
    });
    const summarize = createTask({
      kind: "summarize",
      title: "Summarize result",
      prompt: "Summarize what changed, what was verified, and any remaining limitations.",
      dependencies: [verify.id],
      maxAttempts: this.maxAttempts,
    });

    this.plan = {
      id: randomUUID(),
      goal,
      cwd,
      createdAt: now(),
      tasks: [inspect, plan, execute, verify, summarize],
    };
  }

  get tasks(): WorkflowTask[] {
    return this.plan.tasks;
  }

  getTask(id: string): WorkflowTask | undefined {
    return this.tasks.find(task => task.id === id);
  }

  hasPendingWork(): boolean {
    return this.tasks.some(task => task.status === "pending" || task.status === "running");
  }

  nextRunnable(): WorkflowTask | undefined {
    return this.tasks.find(task => {
      if (task.status !== "pending") return false;
      return task.dependencies.every(depId => this.getTask(depId)?.status === "completed");
    });
  }

  markRunning(task: WorkflowTask): void {
    task.status = "running";
    task.startedAt = now();
    task.attempts += 1;
  }

  markCompleted(task: WorkflowTask): void {
    task.status = "completed";
    task.completedAt = now();
    task.error = undefined;
  }

  markFailed(task: WorkflowTask, error: string): void {
    task.error = error;
    task.completedAt = now();
    task.status = task.attempts < task.maxAttempts ? "pending" : "failed";
  }

  markSkipped(task: WorkflowTask, reason: string): void {
    task.status = "skipped";
    task.error = reason;
    task.completedAt = now();
  }

  schedulePlanItems(items: ParsedPlanItem[], afterTaskId: string): WorkflowTask[] {
    const verify = this.tasks.find(task => task.kind === "verify");
    if (!verify || items.length === 0) return [];

    const existing = new Set(this.tasks.map(task => task.title.toLowerCase()));
    const created: WorkflowTask[] = [];

    for (const item of items) {
      if (existing.has(item.title.toLowerCase())) continue;
      const task = createTask({
        kind: item.kind ?? "execute",
        title: item.title,
        prompt: item.prompt,
        dependencies: item.dependencies?.length ? item.dependencies : [afterTaskId],
        maxAttempts: this.maxAttempts,
      });
      existing.add(item.title.toLowerCase());
      created.push(task);
    }

    if (created.length === 0) return [];

    const verifyIndex = this.tasks.indexOf(verify);
    this.tasks.splice(verifyIndex, 0, ...created);
    verify.dependencies = Array.from(new Set([...verify.dependencies, ...created.map(task => task.id)]));
    return created;
  }

  overallStatus(): "completed" | "failed" {
    return this.tasks.some(task => task.status === "failed") ? "failed" : "completed";
  }

  statusCounts(): Record<WorkflowTaskStatus, number> {
    return this.tasks.reduce<Record<WorkflowTaskStatus, number>>(
      (acc, task) => {
        acc[task.status] += 1;
        return acc;
      },
      { pending: 0, running: 0, completed: 0, failed: 0, skipped: 0 },
    );
  }
}
