import assert from "node:assert/strict";
import {
  OutputParser,
  PromptBuilder,
  TaskScheduler,
  WorkflowEngine,
} from "../dist/index.js";

const parser = new OutputParser();
const parsed = parser.parse(`Here is the plan:

\`\`\`json
{
  "plan": [
    {"title": "Add a file", "prompt": "Create the requested file", "kind": "execute"},
    {"title": "Run checks", "prompt": "Run the relevant checks", "kind": "verify"}
  ]
}
\`\`\`

\`\`\`diff
+hello
\`\`\`
`);

assert.equal(parsed.planItems.length, 2);
assert.equal(parsed.planItems[0].title, "Add a file");
assert.equal(parsed.patches.length, 1);

const scheduler = new TaskScheduler("ship a tiny feature", process.cwd());
assert.equal(scheduler.tasks.length, 5);
assert.equal(scheduler.nextRunnable().kind, "inspect");

const promptBuilder = new PromptBuilder({ maxPromptChars: 10_000 });
const built = promptBuilder.buildTaskPrompt(scheduler.nextRunnable(), {
  goal: "ship a tiny feature",
  cwd: process.cwd(),
  provider: "anthropic",
  model: "claude-sonnet-4-20250514",
  tools: ["read_file", "bash"],
  history: [],
  maxPromptChars: 10_000,
});
assert.match(built.text, /Workflow Goal/);
assert.match(built.text, /Response Contract/);

const listeners = new Set();
const fakeRunner = {
  id: "fake",
  promptCount: 0,
  async prompt(prompt) {
    this.promptCount += 1;
    const output = prompt.includes("Create implementation plan")
      ? '```json\n{"plan":[{"title":"Implement smoke task","prompt":"Pretend to implement it","kind":"execute"}]}\n```'
      : `Completed step ${this.promptCount}.`;
    const event = {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: output },
    };
    for (const listener of listeners) {
      await listener(event);
    }
    return { output, events: [event] };
  },
  async clear() {},
  describe() {
    return "fake runner";
  },
  info() {
    return {
      id: "fake",
      cwd: process.cwd(),
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
      tools: ["read_file", "bash"],
      messages: this.promptCount,
    };
  },
  onEvent(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

const workflowEvents = [];
const engine = new WorkflowEngine(fakeRunner, {
  onEvent(event) {
    workflowEvents.push(event.type);
  },
});
const result = await engine.run("ship a tiny feature");

assert.equal(result.status, "completed");
assert.equal(result.tasks.some(task => task.title === "Implement smoke task"), true);
assert.equal(workflowEvents.includes("workflow_task_scheduled"), true);
assert.equal(workflowEvents.at(-1), "workflow_finished");

console.log("framework smoke ok");
