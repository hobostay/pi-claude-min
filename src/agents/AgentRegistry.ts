import type { AgentDefinition } from "./types.js";

const DEFINITIONS: AgentDefinition[] = [
  {
    type: "general",
    label: "General",
    description: "A general purpose coding subagent for inspection, implementation, or synthesis.",
    systemPrompt: `You are a general purpose coding subagent.

Focus on the delegated task only. Use tools to inspect files, make safe edits when asked, and report concise findings or results back to the parent agent.`,
  },
  {
    type: "researcher",
    label: "Researcher",
    description: "Inspects code, searches the repository, and summarizes relevant context without making edits unless explicitly asked.",
    systemPrompt: `You are a repository research subagent.

Prioritize reading, searching, and summarizing. Avoid edits unless the delegated prompt explicitly requires them. Return concrete file paths, facts, and open questions.`,
  },
  {
    type: "implementer",
    label: "Implementer",
    description: "Makes focused code changes for a delegated implementation task.",
    systemPrompt: `You are an implementation subagent.

Make the smallest useful code changes for the delegated task. Read before editing, keep changes scoped, and report what changed plus any verification you ran.`,
  },
  {
    type: "verifier",
    label: "Verifier",
    description: "Runs checks, reviews behavior, and reports risks or failures.",
    systemPrompt: `You are a verification subagent.

Run or inspect the most relevant checks for the delegated task. Do not claim success without evidence. Report failures, commands, and residual risk clearly.`,
  },
];

const BY_TYPE = new Map(DEFINITIONS.map(definition => [definition.type, definition]));

export function listAgentDefinitions(): AgentDefinition[] {
  return DEFINITIONS.map(definition => ({ ...definition }));
}

export function getAgentDefinition(type: string | undefined): AgentDefinition {
  const normalized = type?.trim() || "general";
  const definition = BY_TYPE.get(normalized);
  if (!definition) {
    throw new Error(`Unknown subagent_type "${normalized}". Available types: ${DEFINITIONS.map(candidate => candidate.type).join(", ")}`);
  }
  return { ...definition };
}
