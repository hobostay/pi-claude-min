import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import { getModels, getProviders, type KnownProvider } from "@earendil-works/pi-ai";
import { AgentManager } from "./agents/AgentManager.js";
import { recallMemories } from "./memory/MemoryRecall.js";
import { PromptBuilder } from "./prompt/PromptBuilder.js";
import { SYSTEM_PROMPT } from "./systemPrompt.js";
import { approveToolCall } from "./permissions.js";
import { createCodingTools } from "./tools.js";
import { createSessionStore } from "./session.js";
import type { AgentDefinition, AgentTask, AgentTaskEvent, SendAgentMessageInput, StopAgentInput } from "./agents/types.js";
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
  prompt(prompt: string, options?: CodingAgentPromptOptions): Promise<CodingAgentTurnResult>;
  clear(): Promise<void>;
  describe(): string;
  info(): CodingAgentSessionInfo;
  agents(): AgentTask[];
  sendAgentMessage(input: SendAgentMessageInput): Promise<AgentTask>;
  stopAgent(input: StopAgentInput): Promise<AgentTask>;
  onEvent?(listener: (event: AgentEvent) => void | Promise<void>): () => void;
  runWorkflow?(goal: string): Promise<unknown>;
};

export type CodingAgentTurnResult = {
  output: string;
  events: AgentEvent[];
};

export type CodingAgentPromptOptions = {
  buildPrompt?: boolean;
};

export type CodingAgentSessionInfo = {
  id: string;
  cwd: string;
  provider: string;
  model: string;
  tools: string[];
  messages: number;
  agents: number;
};

export async function createCodingAgentSession(options: {
  cli: CliOptions;
  session: SessionStore;
  initialMessages?: unknown[];
  echo?: boolean;
  systemPrompt?: string;
  enableSubagents?: boolean;
  onEvent?: (event: AgentEvent) => void | Promise<void>;
}): Promise<CodingAgentSession> {
  const model = resolveModel(options.cli.provider, options.cli.model);
  const shouldEcho = options.echo ?? true;
  const eventListeners = new Set<(event: AgentEvent) => void | Promise<void>>();
  let activeTurn: { output: string; events: AgentEvent[] } | undefined;

  const publishEvent = async (typed: AgentEvent, publishOptions: { trackTurn?: boolean } = {}) => {
    const trackTurn = publishOptions.trackTurn ?? true;
    if (trackTurn) {
      activeTurn?.events.push(typed);
    }
    if (trackTurn && activeTurn && typed.type === "message_update" && typed.assistantMessageEvent?.type === "text_delta") {
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
  };

  const agentManager = options.enableSubagents === false
    ? undefined
    : new AgentManager({
        onEvent: event => publishEvent(event as AgentTaskEvent & AgentEvent),
        createRunner: async (task: AgentTask, definition: AgentDefinition) => {
          const session = await createSessionStore(`${options.session.id}.${task.id}`);
          const systemPrompt = [
            SYSTEM_PROMPT,
            "",
            "Subagent role:",
            definition.systemPrompt,
            "",
            `This subagent task id is ${task.id}. Report results to the parent agent; do not talk directly to the human user.`,
          ].join("\n");
          return createCodingAgentSession({
            cli: options.cli,
            session,
            echo: false,
            systemPrompt,
            enableSubagents: false,
            onEvent: async event => {
              await publishEvent({
                ...event,
                agentId: task.id,
                subagentType: definition.type,
              }, { trackTurn: false });
            },
          });
        },
      });

  const tools = createCodingTools({
    cwd: options.cli.cwd,
    maxReadBytes: options.cli.maxReadBytes,
    agentManager,
  });

  const agent = new Agent({
    initialState: {
      systemPrompt: options.systemPrompt ?? SYSTEM_PROMPT,
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

  agent.subscribe(async event => {
    const typed = event as AgentEvent;
    await publishEvent(typed);

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
    agents: agentManager?.list().length ?? 0,
  });

  return {
    id: options.session.id,
    async prompt(prompt: string, promptOptions: CodingAgentPromptOptions = {}) {
      activeTurn = { output: "", events: [] };
      const turn = activeTurn;
      const shouldBuildPrompt = promptOptions.buildPrompt ?? true;
      const finalPrompt = shouldBuildPrompt
        ? new PromptBuilder().buildDirectPrompt(prompt, {
            cwd: options.cli.cwd,
            provider: options.cli.provider,
            model: options.cli.model,
            tools: tools.map(tool => tool.name),
            history: [],
            maxPromptChars: 24_000,
            memory: await recallMemories({
              cwd: options.cli.cwd,
              query: prompt,
            }),
          }).text
        : prompt;
      await options.session.append({
        type: "user",
        at: new Date().toISOString(),
        content: prompt,
      });

      try {
        await agent.prompt(finalPrompt);
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
        `agents: ${sessionInfo.agents}`,
      ].join("\n");
    },
    agents() {
      return agentManager?.list() ?? [];
    },
    async sendAgentMessage(input) {
      if (!agentManager) {
        throw new Error("Subagents are disabled for this session.");
      }
      return agentManager.sendMessage(input);
    },
    async stopAgent(input) {
      if (!agentManager) {
        throw new Error("Subagents are disabled for this session.");
      }
      return agentManager.stop(input);
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
