export type MemoryType = "user" | "feedback" | "project" | "reference";

export type MemoryRecord = {
  id: string;
  filePath: string;
  name: string;
  description: string;
  type: MemoryType;
  content: string;
  createdAt?: string;
  updatedAt?: string;
  mtimeMs: number;
};

export type MemoryDraft = {
  name: string;
  description?: string;
  type?: MemoryType;
  content: string;
};

export type RecalledMemory = MemoryRecord & {
  score: number;
};

export type MemoryContext = {
  memoryDir: string;
  entrypointPath: string;
  recalled: RecalledMemory[];
};
