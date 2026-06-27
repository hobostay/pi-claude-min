import type { AgentEvent, CodingAgentSession } from "../agent.js";
import { OutputParser } from "../parser/OutputParser.js";
import { PromptBuilder } from "../prompt/PromptBuilder.js";
import type { WorkflowContext, WorkflowStepResult, WorkflowTask } from "../workflow/types.js";

export type AgentStepExecutorOptions = {
  promptBuilder?: PromptBuilder;
  outputParser?: OutputParser;
};

function collectTextDelta(event: AgentEvent): string {
  if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
    return event.assistantMessageEvent.delta ?? "";
  }
  return "";
}

export class AgentStepExecutor {
  readonly promptBuilder: PromptBuilder;
  readonly outputParser: OutputParser;

  constructor(
    readonly runner: CodingAgentSession,
    options: AgentStepExecutorOptions = {},
  ) {
    this.promptBuilder = options.promptBuilder ?? new PromptBuilder();
    this.outputParser = options.outputParser ?? new OutputParser();
  }

  async execute(task: WorkflowTask, context: WorkflowContext): Promise<WorkflowStepResult> {
    const startedAt = new Date().toISOString();
    const builtPrompt = this.promptBuilder.buildTaskPrompt(task, context);
    const events: AgentEvent[] = [];
    let output = "";

    const unsubscribe = this.runner.onEvent?.(event => {
      events.push(event);
      output += collectTextDelta(event);
    });

    try {
      const turn = await this.runner.prompt(builtPrompt.text, { buildPrompt: false });
      output = turn.output || output;
      return {
        taskId: task.id,
        taskTitle: task.title,
        status: "completed",
        output,
        parsed: this.outputParser.parse(output),
        events,
        startedAt,
        completedAt: new Date().toISOString(),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        taskId: task.id,
        taskTitle: task.title,
        status: "failed",
        output,
        parsed: this.outputParser.parse(output),
        events,
        startedAt,
        completedAt: new Date().toISOString(),
        error: message,
      };
    } finally {
      unsubscribe?.();
    }
  }
}
