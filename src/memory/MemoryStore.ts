import fs from "node:fs/promises";
import path from "node:path";
import type { MemoryDraft, MemoryRecord, MemoryType } from "./types.js";

const ENTRYPOINT_NAME = "MEMORY.md";
const VALID_TYPES = new Set<MemoryType>(["user", "feedback", "project", "reference"]);

function expandHome(input: string): string {
  if (!input.startsWith("~/")) return input;
  return path.join(process.env.HOME ?? process.cwd(), input.slice(2));
}

export function getMemoryDir(cwd: string): string {
  const override = process.env.PI_CLAUDE_MIN_MEMORY_DIR;
  if (override?.trim()) {
    return path.resolve(expandHome(override.trim()));
  }
  return path.join(cwd, ".pi-claude-min", "memory");
}

function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "memory";
}

function escapeFrontmatter(value: string): string {
  return JSON.stringify(value);
}

function parseFrontmatter(raw: string): { data: Record<string, string>; body: string } {
  if (!raw.startsWith("---\n")) {
    return { data: {}, body: raw.trim() };
  }
  const end = raw.indexOf("\n---", 4);
  if (end === -1) {
    return { data: {}, body: raw.trim() };
  }
  const header = raw.slice(4, end).trim();
  const body = raw.slice(end + 4).trim();
  const data: Record<string, string> = {};
  for (const line of header.split("\n")) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    const key = match[1]!;
    const rawValue = match[2]!.trim();
    try {
      data[key] = JSON.parse(rawValue);
    } catch {
      data[key] = rawValue.replace(/^['"]|['"]$/g, "");
    }
  }
  return { data, body };
}

function renderMemory(record: Required<Pick<MemoryDraft, "name" | "content">> & {
  description: string;
  type: MemoryType;
  createdAt: string;
  updatedAt: string;
}): string {
  return [
    "---",
    `name: ${escapeFrontmatter(record.name)}`,
    `description: ${escapeFrontmatter(record.description)}`,
    `type: ${record.type}`,
    `createdAt: ${escapeFrontmatter(record.createdAt)}`,
    `updatedAt: ${escapeFrontmatter(record.updatedAt)}`,
    "---",
    "",
    record.content.trim(),
    "",
  ].join("\n");
}

function normalizeType(type: string | undefined): MemoryType {
  return VALID_TYPES.has(type as MemoryType) ? (type as MemoryType) : "project";
}

export class MemoryStore {
  readonly memoryDir: string;
  readonly entrypointPath: string;

  constructor(readonly cwd: string, memoryDir = getMemoryDir(cwd)) {
    this.memoryDir = memoryDir;
    this.entrypointPath = path.join(memoryDir, ENTRYPOINT_NAME);
  }

  async ensure(): Promise<void> {
    await fs.mkdir(this.memoryDir, { recursive: true });
    try {
      await fs.access(this.entrypointPath);
    } catch {
      await fs.writeFile(this.entrypointPath, "# pi-claude-min memory\n\n", "utf8");
    }
  }

  async list(): Promise<MemoryRecord[]> {
    await this.ensure();
    const entries = await fs.readdir(this.memoryDir, { withFileTypes: true });
    const records = await Promise.all(
      entries
        .filter(entry => entry.isFile() && entry.name.endsWith(".md") && entry.name !== ENTRYPOINT_NAME)
        .map(async entry => this.read(path.basename(entry.name, ".md"))),
    );
    return records
      .filter((record): record is MemoryRecord => Boolean(record))
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
  }

  async read(id: string): Promise<MemoryRecord | undefined> {
    const filePath = path.join(this.memoryDir, `${slugify(id)}.md`);
    try {
      const [raw, stat] = await Promise.all([fs.readFile(filePath, "utf8"), fs.stat(filePath)]);
      const { data, body } = parseFrontmatter(raw);
      return {
        id: path.basename(filePath, ".md"),
        filePath,
        name: data.name || path.basename(filePath, ".md"),
        description: data.description || "",
        type: normalizeType(data.type),
        content: body,
        createdAt: data.createdAt,
        updatedAt: data.updatedAt,
        mtimeMs: stat.mtimeMs,
      };
    } catch {
      return undefined;
    }
  }

  async save(draft: MemoryDraft): Promise<MemoryRecord> {
    await this.ensure();
    const id = slugify(draft.name);
    const existing = await this.read(id);
    const now = new Date().toISOString();
    const filePath = path.join(this.memoryDir, `${id}.md`);
    const record = {
      name: draft.name.trim(),
      description: (draft.description ?? existing?.description ?? draft.content.slice(0, 140)).trim(),
      type: draft.type ?? existing?.type ?? "project",
      content: draft.content.trim(),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    await fs.writeFile(filePath, renderMemory(record), "utf8");
    await this.rebuildIndex();
    const saved = await this.read(id);
    if (!saved) throw new Error(`Failed to save memory ${id}`);
    return saved;
  }

  async forget(idOrName: string): Promise<boolean> {
    await this.ensure();
    const id = slugify(idOrName);
    const filePath = path.join(this.memoryDir, `${id}.md`);
    try {
      await fs.unlink(filePath);
      await this.rebuildIndex();
      return true;
    } catch {
      const records = await this.list();
      const matched = records.find(record => record.name.toLowerCase() === idOrName.toLowerCase());
      if (!matched) return false;
      await fs.unlink(matched.filePath);
      await this.rebuildIndex();
      return true;
    }
  }

  async rebuildIndex(): Promise<void> {
    await fs.mkdir(this.memoryDir, { recursive: true });
    const records = await this.listWithoutEnsuringIndex();
    const lines = [
      "# pi-claude-min memory",
      "",
      "This is an index of durable memories for this project. Detailed memories live in separate Markdown files.",
      "",
      ...records.map(record => `- [${record.name}](${path.basename(record.filePath)}) — ${record.description || record.type}`),
      "",
    ];
    await fs.writeFile(this.entrypointPath, lines.join("\n"), "utf8");
  }

  private async listWithoutEnsuringIndex(): Promise<MemoryRecord[]> {
    const entries = await fs.readdir(this.memoryDir, { withFileTypes: true }).catch(() => []);
    const records = await Promise.all(
      entries
        .filter(entry => entry.isFile() && entry.name.endsWith(".md") && entry.name !== ENTRYPOINT_NAME)
        .map(async entry => this.read(path.basename(entry.name, ".md"))),
    );
    return records
      .filter((record): record is MemoryRecord => Boolean(record))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
}
