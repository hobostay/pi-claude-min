#!/usr/bin/env node
import http from "node:http";
import path from "node:path";
import { URL } from "node:url";
import { createCodingAgentSession, type AgentEvent, type CodingAgentSession } from "./agent.js";
import { createSessionStore, loadLatestSnapshot, sessionExists } from "./session.js";
import type { CliOptions, ExecutionMode, PermissionMode } from "./types.js";
import { WorkflowEngine } from "./workflow/WorkflowEngine.js";
import type { WorkflowEvent } from "./workflow/types.js";

type ApiSession = {
  runner: CodingAgentSession;
  events: Array<{ id: number; at: string; event: AgentEvent | ApiEvent | WorkflowEvent }>;
  clients: Set<http.ServerResponse>;
  busy: boolean;
};

type ApiEvent =
  | { type: "session_created"; sessionId: string }
  | { type: "user_message"; prompt: string }
  | { type: "run_started"; prompt: string }
  | { type: "run_finished" }
  | { type: "run_error"; message: string }
  | { type: "context_cleared" };

const sessions = new Map<string, ApiSession>();

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body, null, 2));
}

function notFound(res: http.ServerResponse): void {
  json(res, 404, { error: "not_found" });
}

function methodNotAllowed(res: http.ServerResponse): void {
  json(res, 405, { error: "method_not_allowed" });
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("JSON body must be an object");
  }
  return parsed as Record<string, unknown>;
}

function stringField(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberField(body: Record<string, unknown>, key: string): number | undefined {
  const value = body[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function permissionModeField(body: Record<string, unknown>): PermissionMode {
  const value = stringField(body, "permissionMode") ?? process.env.PI_CLAUDE_MIN_SERVER_PERMISSION_MODE ?? "ask";
  if (value === "ask" || value === "auto" || value === "bypass") {
    return value;
  }
  throw new Error("permissionMode must be ask, auto, or bypass");
}

function executionModeField(body: Record<string, unknown>): ExecutionMode {
  const value = stringField(body, "workflowMode") ?? stringField(body, "mode") ?? "single";
  if (value === "single" || value === "workflow") {
    return value;
  }
  throw new Error("workflowMode must be single or workflow");
}

function emit(apiSession: ApiSession, event: AgentEvent | ApiEvent | WorkflowEvent): void {
  const record = {
    id: apiSession.events.length + 1,
    at: new Date().toISOString(),
    event,
  };
  apiSession.events.push(record);

  const payload = `id: ${record.id}\nevent: message\ndata: ${JSON.stringify(record)}\n\n`;
  for (const client of apiSession.clients) {
    client.write(payload);
  }
}

function sessionResponse(apiSession: ApiSession): Record<string, unknown> {
  return {
    ...apiSession.runner.info(),
    busy: apiSession.busy,
    eventCount: apiSession.events.length,
  };
}

function buildCliOptions(body: Record<string, unknown>): CliOptions {
  return {
    cwd: path.resolve(stringField(body, "cwd") ?? process.cwd()),
    provider: stringField(body, "provider") ?? process.env.PI_PROVIDER ?? "anthropic",
    model: stringField(body, "model") ?? process.env.PI_MODEL ?? "claude-sonnet-4-20250514",
    print: true,
    json: false,
    session: stringField(body, "sessionId"),
    resume: stringField(body, "resume"),
    permissionMode: permissionModeField(body),
    workflowMode: executionModeField(body),
    maxReadBytes: numberField(body, "maxReadBytes") ?? 200_000,
  };
}

async function createApiSession(body: Record<string, unknown>): Promise<ApiSession> {
  const cli = buildCliOptions(body);
  if (cli.resume && !(await sessionExists(cli.resume))) {
    throw new Error(`Cannot resume missing session ${cli.resume}`);
  }

  const sessionStore = await createSessionStore(cli.resume ?? cli.session);
  const initialMessages = cli.resume ? await loadLatestSnapshot(cli.resume) : undefined;
  const apiSession: ApiSession = {
    runner: undefined as unknown as CodingAgentSession,
    events: [],
    clients: new Set(),
    busy: false,
  };

  apiSession.runner = await createCodingAgentSession({
    cli,
    session: sessionStore,
    initialMessages,
    echo: false,
    onEvent: event => emit(apiSession, event),
  });
  emit(apiSession, { type: "session_created", sessionId: apiSession.runner.id });
  sessions.set(apiSession.runner.id, apiSession);
  return apiSession;
}

async function handleCreateSession(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (req.method !== "POST") return methodNotAllowed(res);
  const body = await readJson(req);
  const apiSession = await createApiSession(body);
  json(res, 201, sessionResponse(apiSession));
}

function handleGetSession(id: string, res: http.ServerResponse): void {
  const apiSession = sessions.get(id);
  if (!apiSession) return notFound(res);
  json(res, 200, sessionResponse(apiSession));
}

async function handlePostMessage(id: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (req.method !== "POST") return methodNotAllowed(res);
  const apiSession = sessions.get(id);
  if (!apiSession) return notFound(res);
  if (apiSession.busy) return json(res, 409, { error: "session_busy" });

  const body = await readJson(req);
  const prompt = stringField(body, "prompt");
  if (!prompt) return json(res, 400, { error: "prompt_required" });

  apiSession.busy = true;
  emit(apiSession, { type: "user_message", prompt });
  emit(apiSession, { type: "run_started", prompt });
  json(res, 202, { accepted: true, sessionId: id });

  const promise = executionModeField(body) === "workflow"
    ? new WorkflowEngine(apiSession.runner, { onEvent: event => emit(apiSession, event) }).run(prompt)
    : apiSession.runner.prompt(prompt);

  void promise
    .then(() => emit(apiSession, { type: "run_finished" }))
    .catch(error => emit(apiSession, { type: "run_error", message: error instanceof Error ? error.message : String(error) }))
    .finally(() => {
      apiSession.busy = false;
    });
}

async function handleClear(id: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (req.method !== "POST") return methodNotAllowed(res);
  const apiSession = sessions.get(id);
  if (!apiSession) return notFound(res);
  if (apiSession.busy) return json(res, 409, { error: "session_busy" });
  await apiSession.runner.clear();
  emit(apiSession, { type: "context_cleared" });
  json(res, 200, sessionResponse(apiSession));
}

function handleEvents(id: string, req: http.IncomingMessage, res: http.ServerResponse): void {
  if (req.method !== "GET") return methodNotAllowed(res);
  const apiSession = sessions.get(id);
  if (!apiSession) return notFound(res);

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });

  for (const record of apiSession.events) {
    res.write(`id: ${record.id}\nevent: message\ndata: ${JSON.stringify(record)}\n\n`);
  }
  res.write(": connected\n\n");

  apiSession.clients.add(res);
  req.on("close", () => {
    apiSession.clients.delete(res);
  });
}

async function route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean);

  if (req.method === "GET" && url.pathname === "/health") {
    return json(res, 200, { ok: true, sessions: sessions.size });
  }

  if (parts.length === 2 && parts[0] === "api" && parts[1] === "sessions") {
    return handleCreateSession(req, res);
  }

  if (parts.length === 3 && parts[0] === "api" && parts[1] === "sessions") {
    if (req.method !== "GET") return methodNotAllowed(res);
    return handleGetSession(parts[2]!, res);
  }

  if (parts.length === 4 && parts[0] === "api" && parts[1] === "sessions") {
    const id = parts[2]!;
    const action = parts[3]!;
    if (action === "messages") return handlePostMessage(id, req, res);
    if (action === "events") return handleEvents(id, req, res);
    if (action === "clear") return handleClear(id, req, res);
  }

  return notFound(res);
}

const port = Number.parseInt(process.env.PORT ?? process.env.PI_CLAUDE_MIN_PORT ?? "8787", 10);
const host = process.env.HOST ?? "127.0.0.1";

const server = http.createServer((req, res) => {
  route(req, res).catch(error => {
    json(res, 500, { error: "internal_error", message: error instanceof Error ? error.message : String(error) });
  });
});

server.listen(port, host, () => {
  process.stderr.write(`pi-claude-min API listening on http://${host}:${port}\n`);
});
