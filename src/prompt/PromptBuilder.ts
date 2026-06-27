import type { BuiltPrompt, PromptSection, WorkflowContext, WorkflowTask } from "../workflow/types.js";
import { renderMemoryContext } from "../memory/MemoryRecall.js";

export type PromptBuilderOptions = {
  maxPromptChars?: number;
};

function trimToBudget(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const omitted = text.length - maxChars;
  return `${text.slice(0, maxChars)}\n\n[truncated ${omitted} chars]`;
}

function renderSections(sections: PromptSection[], maxPromptChars: number): BuiltPrompt {
  const text = sections
    .filter(section => section.content.trim().length > 0)
    .map(section => `## ${section.title}\n\n${section.content.trim()}`)
    .join("\n\n");

  return {
    sections,
    text: trimToBudget(text, maxPromptChars),
  };
}

function renderHistory(context: WorkflowContext): string {
  if (context.history.length === 0) {
    return "No workflow steps have completed yet.";
  }

  return context.history
    .map((result, index) => {
      const output = trimToBudget(result.output.trim() || "<no text output>", 2_000);
      return [
        `${index + 1}. ${result.taskTitle} (${result.status})`,
        output,
      ].join("\n");
    })
    .join("\n\n");
}

export class PromptBuilder {
  readonly maxPromptChars: number;

  constructor(options: PromptBuilderOptions = {}) {
    this.maxPromptChars = options.maxPromptChars ?? 24_000;
  }

  buildTaskPrompt(task: WorkflowTask, context: WorkflowContext): BuiltPrompt {
    const sections: PromptSection[] = [
      {
        title: "Workflow Goal",
        content: context.goal,
      },
      {
        title: "Current Step",
        content: [
          `id: ${task.id}`,
          `kind: ${task.kind}`,
          `title: ${task.title}`,
          "",
          task.prompt,
        ].join("\n"),
      },
      {
        title: "Repository Context",
        content: [
          `cwd: ${context.cwd}`,
          `model: ${context.provider}/${context.model}`,
          `available tools: ${context.tools.join(", ")}`,
        ].join("\n"),
      },
      {
        title: "Completed Step History",
        content: renderHistory(context),
      },
      {
        title: "Long-Term Memory",
        content: context.memory
          ? renderMemoryContext(context.memory)
          : "Long-term memory is unavailable for this step.",
      },
      {
        title: "Response Contract",
        content: [
          "Return useful prose for the user, but when this step creates a plan include one of these machine-readable forms:",
          "",
          "```json",
          "{",
          '  "plan": [',
          '    {"title": "Short step title", "prompt": "Actionable instruction", "kind": "execute"}',
          "  ]",
          "}",
          "```",
          "",
          "For final summaries, include a concise result and mention verification performed.",
        ].join("\n"),
      },
    ];

    return renderSections(sections, context.maxPromptChars || this.maxPromptChars);
  }

  buildDirectPrompt(goal: string, context: Omit<WorkflowContext, "goal">): BuiltPrompt {
    return renderSections(
      [
        { title: "Task", content: goal },
        {
          title: "Repository Context",
          content: [
            `cwd: ${context.cwd}`,
            `model: ${context.provider}/${context.model}`,
            `available tools: ${context.tools.join(", ")}`,
          ].join("\n"),
        },
        {
          title: "Long-Term Memory",
          content: context.memory
            ? renderMemoryContext(context.memory)
            : "Long-term memory is unavailable for this task.",
        },
        {
          title: "Instructions",
          content: [
            "Work as a coding agent.",
            "Inspect files before editing.",
            "Run relevant checks when possible.",
            "Summarize changes and verification.",
          ].join("\n"),
        },
      ],
      context.maxPromptChars || this.maxPromptChars,
    );
  }
}
