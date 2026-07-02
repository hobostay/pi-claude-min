export type AgentTaskStatus = "queued" | "running" | "completed" | "failed" | "killed";

export type AgentDefinition = {
  type: string;
  label: string;
  description: string;
  systemPrompt: string;
};

export type AgentTaskTurn = {
  prompt: string;
  startedAt: string;
  finishedAt?: string;
  output?: string;
  error?: string;
};

export type AgentTask = {
  id: string;
  description: string;
  subagentType: string;
  status: AgentTaskStatus;
  background: boolean;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  prompt: string;
  pendingMessages: string[];
  turns: AgentTaskTurn[];
  notification?: string;
  result?: string;
  error?: string;
};

export type AgentTaskEvent =
  | { type: "agent_task_created"; task: AgentTask }
  | { type: "agent_task_started"; task: AgentTask }
  | { type: "agent_task_message_queued"; task: AgentTask; message: string }
  | { type: "agent_task_notification"; task: AgentTask; notification: string }
  | { type: "agent_task_completed"; task: AgentTask }
  | { type: "agent_task_failed"; task: AgentTask; message: string }
  | { type: "agent_task_killed"; task: AgentTask; message: string };

export type SpawnAgentInput = {
  description: string;
  prompt: string;
  subagentType?: string;
  runInBackground?: boolean;
};

export type SendAgentMessageInput = {
  to: string;
  message: string;
  waitForResponse?: boolean;
};

export type StopAgentInput = {
  id: string;
  reason?: string;
};
