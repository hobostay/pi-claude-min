import type { ParsedOutput, ParsedPlanItem, WorkflowTaskKind } from "../workflow/types.js";

const VALID_KINDS = new Set<WorkflowTaskKind>(["inspect", "plan", "execute", "verify", "summarize", "custom"]);

function tryParseJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function extractJsonCandidates(text: string): unknown[] {
  const candidates: unknown[] = [];
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  for (const match of fenced) {
    const parsed = tryParseJson(match[1]?.trim() ?? "");
    if (parsed !== undefined) candidates.push(parsed);
  }

  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const parsed = tryParseJson(text.slice(firstBrace, lastBrace + 1));
    if (parsed !== undefined) candidates.push(parsed);
  }

  return candidates;
}

function normalizePlanItem(value: unknown): ParsedPlanItem | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const title = typeof record.title === "string" ? record.title.trim() : "";
  const prompt = typeof record.prompt === "string" ? record.prompt.trim() : title;
  if (!title || !prompt) return undefined;

  const kind = typeof record.kind === "string" && VALID_KINDS.has(record.kind as WorkflowTaskKind)
    ? (record.kind as WorkflowTaskKind)
    : undefined;
  const dependencies = Array.isArray(record.dependencies)
    ? record.dependencies.filter((item): item is string => typeof item === "string")
    : undefined;

  return { title, prompt, kind, dependencies };
}

function extractJsonPlanItems(json: unknown): ParsedPlanItem[] {
  if (!json || typeof json !== "object") return [];
  const record = json as Record<string, unknown>;
  const plan = Array.isArray(record.plan) ? record.plan : Array.isArray(record.tasks) ? record.tasks : undefined;
  if (!plan) return [];
  return plan.map(normalizePlanItem).filter((item): item is ParsedPlanItem => Boolean(item));
}

function extractMarkdownPlanItems(text: string): ParsedPlanItem[] {
  const items: ParsedPlanItem[] = [];
  for (const line of text.split("\n")) {
    const match = line.match(/^\s*(?:[-*]|\d+[.)])\s+\[?\s*(?:todo|task|step)?\s*\]?\s*(.+)$/i);
    if (!match) continue;
    const title = match[1]?.replace(/\s+/g, " ").trim();
    if (!title || title.length < 4) continue;
    items.push({ title, prompt: title, kind: "execute" });
  }
  return items.slice(0, 12);
}

function uniquePlanItems(items: ParsedPlanItem[]): ParsedPlanItem[] {
  const seen = new Set<string>();
  const unique: ParsedPlanItem[] = [];
  for (const item of items) {
    const key = `${item.title}\n${item.prompt}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  return unique;
}

export class OutputParser {
  parse(text: string): ParsedOutput {
    const errors: string[] = [];
    const jsonCandidates = extractJsonCandidates(text);
    const firstJson = jsonCandidates[0];
    const jsonPlanItems = jsonCandidates.flatMap(extractJsonPlanItems);
    const markdownPlanItems = jsonPlanItems.length > 0 ? [] : extractMarkdownPlanItems(text);
    const patches = [...text.matchAll(/```(?:diff|patch)\s*([\s\S]*?)```/gi)]
      .map(match => match[1]?.trim() ?? "")
      .filter(Boolean);

    if (text.includes("```json") && jsonCandidates.length === 0) {
      errors.push("Found a JSON fence but could not parse it.");
    }

    const finalMatch = text.match(/<final>([\s\S]*?)<\/final>/i);

    return {
      text,
      json: firstJson,
      planItems: uniquePlanItems([...jsonPlanItems, ...markdownPlanItems]),
      patches,
      finalAnswer: finalMatch?.[1]?.trim(),
      errors,
    };
  }
}
