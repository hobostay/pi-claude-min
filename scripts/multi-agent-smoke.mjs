import assert from "node:assert/strict";
import { AgentManager, listAgentDefinitions } from "../dist/index.js";

const events = [];
const prompts = [];
const manager = new AgentManager({
  async createRunner(task, definition) {
    return {
      async prompt(prompt) {
        prompts.push({ taskId: task.id, type: definition.type, prompt });
        await new Promise(resolve => setTimeout(resolve, 5));
        return {
          output: `${definition.type} handled: ${prompt}`,
          events: [{ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "ok" } }],
        };
      },
    };
  },
  onEvent(event) {
    events.push(event.type);
  },
});

assert.equal(listAgentDefinitions().some(definition => definition.type === "researcher"), true);

const syncTask = await manager.spawn({
  description: "inspect docs",
  subagentType: "researcher",
  prompt: "Find the README summary",
});

assert.equal(syncTask.status, "completed");
assert.equal(syncTask.subagentType, "researcher");
assert.match(syncTask.result, /researcher handled/);

const backgroundTask = await manager.spawn({
  description: "verify checks",
  subagentType: "verifier",
  prompt: "Run smoke checks",
  runInBackground: true,
});

assert.equal(backgroundTask.background, true);
assert.equal(["queued", "running", "completed"].includes(backgroundTask.status), true);

const followed = await manager.sendMessage({
  to: backgroundTask.id,
  message: "Also include residual risk",
  waitForResponse: true,
});

assert.equal(followed.status, "completed");
assert.equal(followed.turns.length, 2);
assert.match(followed.result, /residual risk/);
assert.equal(prompts.length, 3);
assert.equal(events.includes("agent_task_created"), true);
assert.equal(events.includes("agent_task_completed"), true);

console.log("multi-agent smoke ok");
