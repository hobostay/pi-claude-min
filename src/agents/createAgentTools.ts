import { Type, type Static, type TSchema } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { AgentManager } from "./AgentManager.js";
import { listAgentDefinitions } from "./AgentRegistry.js";

const AgentParams = Type.Object({
  description: Type.String({ description: "Short task description shown to the parent agent." }),
  prompt: Type.String({ description: "Full instructions for the subagent." }),
  subagent_type: Type.Optional(Type.String({ description: "Subagent role: general, researcher, implementer, or verifier." })),
  run_in_background: Type.Optional(Type.Boolean({ description: "Return immediately while the subagent continues working." })),
});

const SendMessageParams = Type.Object({
  to: Type.String({ description: "Agent task id returned by the agent tool." }),
  message: Type.String({ description: "Follow-up message for the subagent." }),
  wait_for_response: Type.Optional(Type.Boolean({ description: "Wait until the subagent answers before returning." })),
});

type AgentParams = Static<typeof AgentParams>;
type SendMessageParams = Static<typeof SendMessageParams>;
type ToolResult = AgentToolResult<Record<string, unknown>>;

function defineTool<TParameters extends TSchema>(
  tool: AgentTool<TParameters, Record<string, unknown>>,
): AgentTool<TParameters, Record<string, unknown>> {
  return tool;
}

function textResult(text: string, details?: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text }], details: details ?? {} };
}

export function createAgentTools(agentManager: AgentManager | undefined): AgentTool[] {
  if (!agentManager) {
    return [];
  }

  const roleSummary = listAgentDefinitions()
    .map(definition => `${definition.type}: ${definition.description}`)
    .join("\n");

  return [
    defineTool({
      name: "agent",
      label: "Agent",
      description: `Delegate work to a subagent. Available subagent_type values:\n${roleSummary}`,
      parameters: AgentParams,
      executionMode: "sequential",
      execute: async (_toolCallId: string, params: AgentParams) => {
        const task = await agentManager.spawn({
          description: params.description,
          prompt: params.prompt,
          subagentType: params.subagent_type,
          runInBackground: params.run_in_background,
        });
        const text = [
          `agent_id: ${task.id}`,
          `status: ${task.status}`,
          `subagent_type: ${task.subagentType}`,
          task.result ? `result:\n${task.result}` : "result: <pending>",
          task.error ? `error: ${task.error}` : undefined,
        ].filter(Boolean).join("\n");
        return textResult(text, { task });
      },
    }),
    defineTool({
      name: "send_message",
      label: "Send Message",
      description: "Send a follow-up message to a running or completed subagent task.",
      parameters: SendMessageParams,
      executionMode: "sequential",
      execute: async (_toolCallId: string, params: SendMessageParams) => {
        const task = await agentManager.sendMessage({
          to: params.to,
          message: params.message,
          waitForResponse: params.wait_for_response,
        });
        const text = [
          `agent_id: ${task.id}`,
          `status: ${task.status}`,
          task.result ? `latest_result:\n${task.result}` : "latest_result: <pending>",
          task.pendingMessages.length ? `pending_messages: ${task.pendingMessages.length}` : undefined,
        ].filter(Boolean).join("\n");
        return textResult(text, { task });
      },
    }),
  ];
}
