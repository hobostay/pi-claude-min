# pi-claude-min

pi-claude-min is a lightweight, Claude Code style coding agent built on the Pi framework. It provides a small but practical agent loop for reading projects, editing files, running shell commands, saving sessions, and exposing the same core agent through a CLI, HTTP API, SSE event stream, and TypeScript SDK.

The project uses public Pi packages as its agent substrate:

- `@earendil-works/pi-ai` for model/provider access.
- `@earendil-works/pi-agent-core` for the agent loop, tool calling, streaming, and tool execution.

## Install

```bash
npm install
npm run build
```

## Run

```bash
npm run dev -- "summarize this repository"
npm run dev -- --yes "run tests and fix the first failure"
npm run dev -- --workflow --yes "implement the requested feature and verify it"
npm run dev -- --provider openai --model gpt-4o-mini "inspect package.json"
npm run dev
npm run dev:server
```

The default provider/model is:

```text
provider: anthropic
model: claude-sonnet-4-20250514
```

Override with `--provider`, `--model`, `PI_PROVIDER`, or `PI_MODEL`.

Use `--workflow` for multi-step task execution. Workflow mode runs the request through inspect, plan, execute, verify, and summarize phases using the framework modules described below.

## Tools

The first version includes:

- `read_file`: read UTF-8 text files.
- `write_file`: create or overwrite files.
- `edit_file`: exact single replacement edits.
- `bash`: run shell commands.
- `grep`: search with ripgrep.
- `list_files`: inspect files with `find`.

Sensitive tools (`write_file`, `edit_file`, `bash`) ask for approval by default. Use `--yes` for auto-approval in trusted local runs, or `--dangerously-skip-permissions` for full bypass.

## Sessions

Sessions are written as JSONL under the current project's local state directory:

```text
.pi-claude-min/sessions/
```

Set `PI_CLAUDE_MIN_HOME` to choose a different state directory. Use `--session <id>` to choose an id or `--resume <id>` to append to an existing session file.

`--resume` restores the latest saved message snapshot and continues from that context.

## Long-Term Memory

pi-claude-min includes a simple file-based long-term memory system inspired by durable agent memory patterns:

- Memories are stored under `.pi-claude-min/memory/` in the target project.
- `MEMORY.md` is an index of durable memories.
- Each detailed memory is a separate Markdown file with frontmatter.
- Before each task, pi-claude-min recalls relevant memories by matching the user query against memory names, descriptions, types, and content.
- Recalled memories are injected into the prompt as context, but the agent is instructed to verify memory against the current repository before relying on it.

Override the memory directory with:

```bash
PI_CLAUDE_MIN_MEMORY_DIR=/path/to/memory
```

Interactive memory commands:

```text
/memory
/remember testing preference: always run smoke tests before summarizing
/forget testing-preference
```

## Interactive Commands

When started without a prompt in a TTY, the agent opens a tiny REPL:

- `/help`: show commands.
- `/model`: show active model.
- `/workflow`: toggle workflow mode.
- `/memory`: list long-term memories.
- `/remember <name>: <text>`: save a long-term memory.
- `/forget <id-or-name>`: delete a long-term memory.
- `/session`: show session details.
- `/tools`: show enabled tools.
- `/clear`: clear conversation context.
- `/exit`: quit.

## Workflow Engine

pi-claude-min includes a small framework layer above the raw Pi agent loop:

- `PromptBuilder`: assembles large step prompts from the user goal, repository context, available tools, completed workflow history, and a response contract.
- `OutputParser`: extracts JSON plans, Markdown task lists, diff/patch fences, final answer tags, and parser errors from model output.
- `TaskScheduler`: owns task state, dependencies, attempts, dynamic task insertion, and status accounting.
- `AgentStepExecutor`: runs one scheduled task through the agent, collects streaming events, aggregates text output, and parses the result.
- `WorkflowEngine`: coordinates inspect, plan, execute, verify, and summarize phases. If the plan step returns machine-readable plan items, it inserts them before verification.

CLI workflow mode:

```bash
npm run dev -- --workflow --yes "add a small feature and verify it"
```

HTTP workflow mode:

```bash
curl -s http://127.0.0.1:8787/api/sessions/<id>/messages \
  -H 'content-type: application/json' \
  -d '{"prompt":"add a small feature and verify it","workflowMode":"workflow"}'
```

## HTTP API

Start the local API server:

```bash
npm run dev:server
```

The server listens on `127.0.0.1:8787` by default. Override with `HOST` and `PORT`.

Create a session:

```bash
curl -s http://127.0.0.1:8787/api/sessions \
  -H 'content-type: application/json' \
  -d '{"cwd":"/path/to/project","permissionMode":"auto"}'
```

Send a message:

```bash
curl -s http://127.0.0.1:8787/api/sessions/<id>/messages \
  -H 'content-type: application/json' \
  -d '{"prompt":"read the project and summarize it"}'
```

Stream events with Server-Sent Events:

```bash
curl -N http://127.0.0.1:8787/api/sessions/<id>/events
```

Endpoints:

- `GET /health`: server status.
- `POST /api/sessions`: create a session.
- `GET /api/sessions/:id`: inspect a session.
- `POST /api/sessions/:id/messages`: enqueue one prompt.
- `GET /api/sessions/:id/events`: stream session events with SSE.
- `POST /api/sessions/:id/clear`: clear context.
- `GET /api/sessions/:id/memory`: list long-term memories.
- `POST /api/sessions/:id/memory/remember`: save a memory.
- `POST /api/sessions/:id/memory/forget`: delete a memory.

## TypeScript API

The package also exports the core pieces for embedding:

```ts
import {
  createCodingAgentSession,
  createSessionStore,
} from "pi-claude-min";

const session = await createSessionStore();
const runner = await createCodingAgentSession({
  session,
  echo: false,
  cli: {
    cwd: process.cwd(),
    provider: "anthropic",
    model: "claude-sonnet-4-20250514",
    print: true,
    json: false,
    permissionMode: "auto",
    workflowMode: "single",
    maxReadBytes: 200_000,
  },
  onEvent(event) {
    console.log(event.type);
  },
});

await runner.prompt("inspect the project");
```

Run a full workflow from TypeScript:

```ts
import { WorkflowEngine } from "pi-claude-min";

const engine = new WorkflowEngine(runner, {
  onEvent(event) {
    console.log(event.type);
  },
});

const result = await engine.run("implement a small feature and verify it");
console.log(result.status);
```

Use memory from TypeScript:

```ts
import { MemoryStore, recallMemories } from "pi-claude-min";

const memory = new MemoryStore(process.cwd());
await memory.save({
  name: "Testing preference",
  type: "feedback",
  content: "Run smoke tests before summarizing changes.",
});

const recalled = await recallMemories({
  cwd: process.cwd(),
  query: "what should I verify?",
});
console.log(recalled.recalled);
```

## Current Scope

Implemented:

- Pi-based agent construction.
- Minimal Claude Code style system prompt.
- File/search/shell tools.
- Permission gate for mutating tools.
- Print mode and JSONL event mode.
- Interactive multi-turn mode.
- JSONL session logging with resumable snapshots.
- Local HTTP API with SSE event streaming.
- TypeScript exports for embedding the agent directly.
- Task scheduling with dependency-aware workflow tasks.
- Prompt builder for large structured step prompts.
- Output parser for plans, patches, final answers, and parser errors.
- Workflow engine for inspect/plan/execute/verify/summarize runs.
- Step executor that collects streaming events and parsed results.
- File-based long-term memory with explicit remember/forget/list APIs and prompt-time recall.

Next useful milestones:

- Add automatic background memory extraction from completed sessions.
- Add `/compact` and `/cost` slash commands.
- Add patch-style edits and diff previews.
- Add MCP tool loading.
- Add sub-agent task tool.
- Replace the simple terminal output with `pi-tui` components.

## License

MIT
