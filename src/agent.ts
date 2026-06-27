import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import { getModels, getProviders, type KnownProvider } from "@earendil-works/pi-ai";
import { SYSTEM_PROMPT } from "./systemPrompt.js";
import { approveToolCall } from "./permissions.js";
import { createCodingTools } from "./tools.js";
import type { CliOptions } from "./types.js";
import type { SessionStore } from "./session.js";

export type AgentEvent = {
  type: string;
  assistantMessageEvent?: {
    type: string;
    delta?: string;
  };
  toolName?: string;
  toolCall?: {
    name?: string;
  };
  [key: string]: unknown;
};

function resolveProvider(provider: string): KnownProvider {
  const providers = getProviders();
  if (providers.includes(provider as KnownProvider)) {
    return provider as KnownProvider;
  }
  throw new Error(`Unknown provider "${provider}". Available providers: ${providers.join(", ")}`);
}

function resolveModel(providerName: string, modelId: string) {
  const provider = resolveProvider(providerName);
  const model = getModels(provider).find(candidate => candidate.id === modelId);
  if (!model) {
    const examples = getModels(provider)
      .slice(0, 12)
      .map(candidate => candidate.id)
      .join(", ");
    throw new Error(`Unknown model "${modelId}" for provider "${provider}". Examples: ${examples}`);
  }
  return model;
}

export async function runAgentPrompt(options: {
  prompt: string;
  cli: CliOptions;
  session: SessionStore;
}): Promise<void> {
  const runner = await createCodingAgentSession({
    cli: options.cli,
    session: options.session,
  });
  await runner.prompt(options.prompt);
}

export type CodingAgentSession = {
  id: string;
  prompt(prompt: string): Promise<CodingAgentTurnResult>;
  clear(): Promise<void>;
  describe(): string;
  info(): CodingAgentSessionInfo;
  onEvent?(listener: (event: AgentEvent) => void | Promise<void>): () => void;
  runWorkflow?(goal: string): Promise<unknown>;
};

export type CodingAgentTurnResult = {
  output: string;
  events: AgentEvent[];
};

export type CodingAgentSessionInfo = {
  id: string;
  cwd: string;
  provider: string;
  model: string;
  tools: string[];
  messages: number;
};

export async function createCodingAgentSession(options: {
  cli: CliOptions;
  session: SessionStore;
  initialMessages?: unknown[];
  echo?: boolean;
  onEvent?: (event: AgentEvent) => void | Promise<void>;
}): Promise<CodingAgentSession> {
  const model = resolveModel(options.cli.provider, options.cli.model);
  const tools = createCodingTools({
    cwd: options.cli.cwd,
    maxReadBytes: options.cli.maxReadBytes,
  });

  const agent = new Agent({
    initialState: {
      systemPrompt: SYSTEM_PROMPT,
      model,
      tools,
      messages: (options.initialMessages ?? []) as AgentMessage[],
      thinkingLevel: "off",
    },
    toolExecution: "parallel",
    beforeToolCall: async ({ toolCall, args }: { toolCall: { name: string }; args: unknown }) => {
      const decision = await approveToolCall({
        mode: options.cli.permissionMode,
        toolName: toolCall.name,
        args,
      });
      if (!decision.allow) {
        return { block: true, reason: decision.reason ?? "Tool call denied." };
      }
      return undefined;
    },
  });

  await options.session.append({
    type: "meta",
    sessionId: options.session.id,
    cwd: options.cli.cwd,
    provider: options.cli.provider,
    model: options.cli.model,
    createdAt: new Date().toISOString(),
  });

  const shouldEcho = options.echo ?? true;
  const eventListeners = new Set<(event: AgentEvent) => void | Promise<void>>();
  let activeTurn: { output: string; events: AgentEvent[] } | undefined;

  agent.subscribe(async event => {
    const typed = event as AgentEvent;
    activeTurn?.events.push(typed);
    if (activeTurn && typed.type === "message_update" && typed.assistantMessageEvent?.type === "text_delta") {
      activeTurn.output += typed.assistantMessageEvent.delta ?? "";
    }
    await options.session.append({
      type: "event",
      at: new Date().toISOString(),
      event: typed,
    });
    await options.onEvent?.(typed);
    for (const listener of eventListeners) {
      await listener(typed);
    }

    if (!shouldEcho) {
      return;
    }

    if (options.cli.json) {
      process.stdout.write(`${JSON.stringify(typed)}\n`);
      return;
    }

    if (typed.type === "message_update" && typed.assistantMessageEvent?.type === "text_delta") {
      process.stdout.write(typed.assistantMessageEvent.delta ?? "");
      return;
    }

    if (!options.cli.print) {
      if (typed.type === "tool_execution_start") {
        const name = typed.toolName ?? typed.toolCall?.name ?? "tool";
        process.stderr.write(`\n[${name}]\n`);
      }
      if (typed.type === "tool_execution_end") {
        process.stderr.write("[done]\n");
      }
    }
  });

  const info = (): CodingAgentSessionInfo => ({
    id: options.session.id,
    cwd: options.cli.cwd,
    provider: options.cli.provider,
    model: options.cli.model,
    tools: tools.map(tool => tool.name),
    messages: agent.state.messages.length,
  });

  return {
    id: options.session.id,
    async prompt(prompt: string) {
      activeTurn = { output: "", events: [] };
      const turn = activeTurn;
      await options.session.append({
        type: "user",
        at: new Date().toISOString(),
        content: prompt,
      });

      try {
        await agent.prompt(prompt);
      } finally {
        activeTurn = undefined;
        if (shouldEcho && !options.cli.json) {
          process.stdout.write("\n");
          process.stderr.write(`session: ${options.session.id}\n`);
        }
        await options.session.append({
          type: "snapshot",
          at: new Date().toISOString(),
          messages: agent.state.messages,
        });
      }

      return turn;
    },
    async clear() {
      agent.state.messages = [];
      await options.session.append({
        type: "snapshot",
        at: new Date().toISOString(),
        messages: [],
      });
    },
    describe() {
      const sessionInfo = info();
      return [
        `session: ${sessionInfo.id}`,
        `cwd: ${sessionInfo.cwd}`,
        `model: ${sessionInfo.provider}/${sessionInfo.model}`,
        `tools: ${sessionInfo.tools.join(", ")}`,
        `messages: ${sessionInfo.messages}`,
      ].join("\n");
    },
    onEvent(listener) {
      eventListeners.add(listener);
      return () => {
        eventListeners.delete(listener);
      };
    },
    info,
  };
}
