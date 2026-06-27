import type { MemoryContext, RecalledMemory } from "./types.js";
import { MemoryStore } from "./MemoryStore.js";

function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .map(token => token.trim())
    .filter(token => token.length >= 2);
}

function scoreMemory(queryTokens: string[], text: string): number {
  const haystack = text.toLowerCase();
  let score = 0;
  for (const token of queryTokens) {
    if (haystack.includes(token)) score += token.length;
  }
  return score;
}

export async function recallMemories(options: {
  cwd: string;
  query: string;
  limit?: number;
}): Promise<MemoryContext> {
  const store = new MemoryStore(options.cwd);
  await store.ensure();
  const memories = await store.list();
  const queryTokens = tokenize(options.query);
  const recalled: RecalledMemory[] = memories
    .map(memory => {
      const weighted = [
        memory.name,
        memory.name,
        memory.description,
        memory.description,
        memory.type,
        memory.content,
      ].join("\n");
      return { ...memory, score: scoreMemory(queryTokens, weighted) };
    })
    .filter(memory => memory.score > 0 || queryTokens.length === 0)
    .sort((a, b) => b.score - a.score || b.mtimeMs - a.mtimeMs)
    .slice(0, options.limit ?? 5);

  return {
    memoryDir: store.memoryDir,
    entrypointPath: store.entrypointPath,
    recalled,
  };
}

export function renderMemoryContext(context: MemoryContext): string {
  if (context.recalled.length === 0) {
    return [
      `memoryDir: ${context.memoryDir}`,
      "No relevant long-term memories were recalled for this task.",
    ].join("\n");
  }

  return [
    `memoryDir: ${context.memoryDir}`,
    `entrypoint: ${context.entrypointPath}`,
    "",
    ...context.recalled.map(memory => [
      `### ${memory.name}`,
      `id: ${memory.id}`,
      `type: ${memory.type}`,
      memory.description ? `description: ${memory.description}` : undefined,
      memory.updatedAt ? `updatedAt: ${memory.updatedAt}` : undefined,
      "",
      memory.content,
    ].filter(Boolean).join("\n")),
  ].join("\n\n");
}
