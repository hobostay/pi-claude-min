import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { SessionRecord } from "./types.js";

function getSessionDir(): string {
  const baseDir = process.env.PI_CLAUDE_MIN_HOME ?? path.join(process.cwd(), ".pi-claude-min");
  return path.join(baseDir.replace(/^~(?=$|\/|\\)/, os.homedir()), "sessions");
}

export type SessionStore = {
  id: string;
  path: string;
  append(record: SessionRecord): Promise<void>;
};

export async function createSessionStore(id: string = randomUUID()): Promise<SessionStore> {
  const sessionDir = getSessionDir();
  await fs.mkdir(sessionDir, { recursive: true });
  const sessionPath = path.join(sessionDir, `${id}.jsonl`);

  return {
    id,
    path: sessionPath,
    async append(record: SessionRecord) {
      await fs.appendFile(sessionPath, `${JSON.stringify(record)}\n`, "utf8");
    },
  };
}

export async function sessionExists(id: string): Promise<boolean> {
  try {
    await fs.access(path.join(getSessionDir(), `${id}.jsonl`));
    return true;
  } catch {
    return false;
  }
}

export function getSessionPath(id: string): string {
  return path.join(getSessionDir(), `${id}.jsonl`);
}

export async function loadLatestSnapshot(id: string): Promise<unknown[] | undefined> {
  const sessionPath = getSessionPath(id);
  const content = await fs.readFile(sessionPath, "utf8");
  let latest: unknown[] | undefined;

  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    const record = JSON.parse(line) as SessionRecord;
    if (record.type === "snapshot") {
      latest = record.messages;
    }
  }

  return latest;
}
