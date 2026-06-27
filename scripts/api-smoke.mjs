import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const port = 18_987 + Math.floor(Math.random() * 1000);
const cwd = await mkdtemp(path.join(tmpdir(), "pi-claude-min-api-"));
const stateHome = path.join(cwd, ".state");
const server = spawn(process.execPath, ["dist/server.js"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PORT: String(port),
    HOST: "127.0.0.1",
    PI_CLAUDE_MIN_HOME: stateHome,
  },
  stdio: ["ignore", "ignore", "pipe"],
});

let stderr = "";
server.stderr.on("data", chunk => {
  stderr += chunk.toString();
});

async function waitForHealth() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`API server did not start. stderr: ${stderr}`);
}

async function request(method, pathname, body) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  const json = text ? JSON.parse(text) : {};
  return { response, json };
}

try {
  await waitForHealth();

  const health = await request("GET", "/health");
  assert.equal(health.response.status, 200);
  assert.equal(health.json.ok, true);

  const created = await request("POST", "/api/sessions", {
    cwd,
    permissionMode: "auto",
  });
  assert.equal(created.response.status, 201);
  assert.equal(typeof created.json.id, "string");
  assert.equal(created.json.cwd, cwd);
  assert.deepEqual(created.json.tools, ["read_file", "write_file", "edit_file", "bash", "grep", "list_files", "agent", "send_message"]);
  assert.equal(created.json.agents, 0);

  const sessionId = created.json.id;
  const fetched = await request("GET", `/api/sessions/${sessionId}`);
  assert.equal(fetched.response.status, 200);
  assert.equal(fetched.json.id, sessionId);

  const agents = await request("GET", `/api/sessions/${sessionId}/agents`);
  assert.equal(agents.response.status, 200);
  assert.deepEqual(agents.json.agents, []);

  const remembered = await request("POST", `/api/sessions/${sessionId}/memory/remember`, {
    name: "API Preference",
    type: "feedback",
    content: "API users prefer SSE events for long-running work.",
  });
  assert.equal(remembered.response.status, 201);
  assert.equal(remembered.json.memory.id, "api-preference");

  const memories = await request("GET", `/api/sessions/${sessionId}/memory`);
  assert.equal(memories.response.status, 200);
  assert.equal(memories.json.memories.length, 1);

  const eventsResponse = await fetch(`http://127.0.0.1:${port}/api/sessions/${sessionId}/events`);
  assert.equal(eventsResponse.status, 200);
  const reader = eventsResponse.body.getReader();
  const firstChunk = await reader.read();
  await reader.cancel();
  assert.match(Buffer.from(firstChunk.value).toString("utf8"), /session_created/);

  const cleared = await request("POST", `/api/sessions/${sessionId}/clear`, {});
  assert.equal(cleared.response.status, 200);
  assert.equal(cleared.json.messages, 0);

  const forgotten = await request("POST", `/api/sessions/${sessionId}/memory/forget`, {
    id: "api-preference",
  });
  assert.equal(forgotten.response.status, 200);
  assert.equal(forgotten.json.deleted, true);

  console.log("api smoke ok");
} finally {
  server.kill("SIGTERM");
  await new Promise(resolve => server.once("exit", resolve));
  await rm(cwd, { recursive: true, force: true });
}
