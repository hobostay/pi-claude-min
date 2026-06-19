# pi-claude-min

Clean-room minimal Claude Code style coding agent built on the Pi framework.

This project intentionally does not reuse code from the archived source snapshot in the parent repository. It uses the public Pi packages as the agent substrate:

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

## Interactive Commands

When started without a prompt in a TTY, the agent opens a tiny REPL:

- `/help`: show commands.
- `/model`: show active model.
- `/session`: show session details.
- `/tools`: show enabled tools.
- `/clear`: clear conversation context.
- `/exit`: quit.

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
    maxReadBytes: 200_000,
  },
  onEvent(event) {
    console.log(event.type);
  },
});

await runner.prompt("inspect the project");
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

Next useful milestones:

- Add `/compact`, `/cost`, `/model`, and `/help` slash commands.
- Add patch-style edits and diff previews.
- Add MCP tool loading.
- Add sub-agent task tool.
- Replace the simple terminal output with `pi-tui` components.

## License

MIT
