import type { AgentEvent } from "../agent.js";

export type WorkflowTaskKind = "inspect" | "plan" | "execute" | "verify" | "summarize" | "custom";

export type WorkflowTaskStatus = "pending" | "running" | "completed" | "failed" | "skipped";

export type WorkflowExecutionMode = "single" | "workflow";

export type WorkflowTask = {
  id: string;
  kind: WorkflowTaskKind;
  title: string;
  prompt: string;
  status: WorkflowTaskStatus;
  dependencies: string[];
  attempts: number;
  maxAttempts: number;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  result?: WorkflowStepResult;
};

export type WorkflowPlan = {
  id: string;
  goal: string;
  cwd: string;
  createdAt: string;
  tasks: WorkflowTask[];
};

export type WorkflowContext = {
  goal: string;
  cwd: string;
  provider: string;
  model: string;
  tools: string[];
  history: WorkflowStepResult[];
  maxPromptChars: number;
};

export type PromptSection = {
  title: string;
  content: string;
};

export type BuiltPrompt = {
  text: string;
  sections: PromptSection[];
};

export type ParsedPlanItem = {
  title: string;
  prompt: string;
  kind?: WorkflowTaskKind;
  dependencies?: string[];
};

export type ParsedOutput = {
  text: string;
  json?: unknown;
  planItems: ParsedPlanItem[];
  patches: string[];
  finalAnswer?: string;
  errors: string[];
};

export type WorkflowStepResult = {
  taskId: string;
  taskTitle: string;
  status: "completed" | "failed";
  output: string;
  parsed: ParsedOutput;
  events: AgentEvent[];
  startedAt: string;
  completedAt: string;
  error?: string;
};

export type WorkflowRunResult = {
  id: string;
  goal: string;
  status: "completed" | "failed";
  tasks: WorkflowTask[];
  results: WorkflowStepResult[];
  startedAt: string;
  completedAt: string;
};

export type WorkflowEvent =
  | { type: "workflow_started"; workflowId: string; goal: string }
  | { type: "workflow_task_started"; workflowId: string; task: WorkflowTask }
  | { type: "workflow_task_completed"; workflowId: string; task: WorkflowTask; result: WorkflowStepResult }
  | { type: "workflow_task_failed"; workflowId: string; task: WorkflowTask; result: WorkflowStepResult }
  | { type: "workflow_task_scheduled"; workflowId: string; task: WorkflowTask }
  | { type: "workflow_finished"; workflowId: string; result: WorkflowRunResult };
