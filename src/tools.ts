import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { Type, type Static, type TSchema } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { displayPath, resolveInsideCwd } from "./pathSafety.js";
import type { ToolEnvironment } from "./types.js";

const ReadFileParams = Type.Object({
  path: Type.String({ description: "Path to read, relative to the working directory." }),
});

const WriteFileParams = Type.Object({
  path: Type.String({ description: "Path to write, relative to the working directory." }),
  content: Type.String({ description: "Complete file content to write." }),
});

const EditFileParams = Type.Object({
  path: Type.String({ description: "Path to edit, relative to the working directory." }),
  oldText: Type.String({ description: "Exact text to replace." }),
  newText: Type.String({ description: "Replacement text." }),
});

const BashParams = Type.Object({
  command: Type.String({ description: "Shell command to run from the working directory." }),
  timeoutMs: Type.Optional(Type.Number({ description: "Optional timeout in milliseconds." })),
});

const GrepParams = Type.Object({
  pattern: Type.String({ description: "Text or regex pattern to search for." }),
  path: Type.Optional(Type.String({ description: "Optional relative path to search within." })),
});

const ListFilesParams = Type.Object({
  path: Type.Optional(Type.String({ description: "Optional directory path, defaults to cwd." })),
});

type ReadFileParams = Static<typeof ReadFileParams>;
type WriteFileParams = Static<typeof WriteFileParams>;
type EditFileParams = Static<typeof EditFileParams>;
type BashParams = Static<typeof BashParams>;
type GrepParams = Static<typeof GrepParams>;
type ListFilesParams = Static<typeof ListFilesParams>;

type ToolResult = AgentToolResult<Record<string, unknown>>;

function textResult(text: string, details?: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text }], details: details ?? {} };
}

function defineTool<TParameters extends TSchema>(
  tool: AgentTool<TParameters, Record<string, unknown>>,
): AgentTool<TParameters, Record<string, unknown>> {
  return tool;
}

async function readTextFile(filePath: string, maxReadBytes: number): Promise<string> {
  const handle = await fs.open(filePath, "r");
  try {
    const stat = await handle.stat();
    const bytesToRead = Math.min(stat.size, maxReadBytes);
    const buffer = Buffer.alloc(bytesToRead);
    await handle.read(buffer, 0, bytesToRead, 0);
    const suffix = stat.size > maxReadBytes ? `\n\n[truncated after ${maxReadBytes} bytes]` : "";
    return `${buffer.toString("utf8")}${suffix}`;
  } finally {
    await handle.close();
  }
}

function runCommand(command: string, cwd: string, timeoutMs: number, signal: AbortSignal): Promise<ToolResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      child.kill("SIGTERM");
      settled = true;
      reject(new Error(`Command timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const abort = () => {
      if (settled) return;
      child.kill("SIGTERM");
      settled = true;
      clearTimeout(timer);
      reject(new Error("Command aborted"));
    };

    signal.addEventListener("abort", abort, { once: true });
    child.stdout?.on("data", chunk => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", chunk => {
      stderr += chunk.toString();
    });
    child.on("error", error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(error);
    });
    child.on("close", code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      const output = [
        `$ ${command}`,
        "",
        stdout ? `stdout:\n${stdout}` : "stdout: <empty>",
        stderr ? `stderr:\n${stderr}` : "stderr: <empty>",
        `exit_code: ${code ?? "unknown"}`,
      ].join("\n");
      resolve(textResult(output, { code, command }));
    });
  });
}

export function createCodingTools(env: ToolEnvironment): AgentTool[] {
  return [
    defineTool({
      name: "read_file",
      label: "Read File",
      description: "Read a UTF-8 text file from the working directory.",
      parameters: ReadFileParams,
      execute: async (_toolCallId: string, params: ReadFileParams) => {
        const filePath = resolveInsideCwd(env.cwd, params.path);
        const content = await readTextFile(filePath, env.maxReadBytes);
        return textResult(content, { path: displayPath(env.cwd, filePath) });
      },
    }),
    defineTool({
      name: "write_file",
      label: "Write File",
      description: "Create or overwrite a UTF-8 text file in the working directory.",
      parameters: WriteFileParams,
      executionMode: "sequential",
      execute: async (_toolCallId: string, params: WriteFileParams) => {
        const filePath = resolveInsideCwd(env.cwd, params.path);
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, params.content, "utf8");
        return textResult(`Wrote ${params.content.length} characters to ${displayPath(env.cwd, filePath)}.`, {
          path: displayPath(env.cwd, filePath),
          bytes: Buffer.byteLength(params.content),
        });
      },
    }),
    defineTool({
      name: "edit_file",
      label: "Edit File",
      description: "Replace exact text in a UTF-8 file. Fails if oldText is missing or appears multiple times.",
      parameters: EditFileParams,
      executionMode: "sequential",
      execute: async (_toolCallId: string, params: EditFileParams) => {
        const filePath = resolveInsideCwd(env.cwd, params.path);
        const original = await fs.readFile(filePath, "utf8");
        const first = original.indexOf(params.oldText);
        if (first === -1) {
          throw new Error("oldText was not found in the file.");
        }
        if (original.indexOf(params.oldText, first + params.oldText.length) !== -1) {
          throw new Error("oldText appears more than once. Provide a more specific replacement.");
        }
        const next = original.replace(params.oldText, params.newText);
        await fs.writeFile(filePath, next, "utf8");
        return textResult(`Edited ${displayPath(env.cwd, filePath)}.`, {
          path: displayPath(env.cwd, filePath),
          oldBytes: Buffer.byteLength(original),
          newBytes: Buffer.byteLength(next),
        });
      },
    }),
    defineTool({
      name: "bash",
      label: "Bash",
      description: "Run a shell command from the working directory.",
      parameters: BashParams,
      executionMode: "sequential",
      execute: async (_toolCallId: string, params: BashParams, signal?: AbortSignal) => {
        return runCommand(params.command, env.cwd, params.timeoutMs ?? 120_000, signal ?? new AbortController().signal);
      },
    }),
    defineTool({
      name: "grep",
      label: "Grep",
      description: "Search files with ripgrep. Use this before broad manual inspection.",
      parameters: GrepParams,
      execute: async (_toolCallId: string, params: GrepParams, signal?: AbortSignal) => {
        const searchPath = params.path ? resolveInsideCwd(env.cwd, params.path) : env.cwd;
        const command = `rg --line-number --hidden --glob '!node_modules' --glob '!.git' ${JSON.stringify(params.pattern)} ${JSON.stringify(searchPath)}`;
        return runCommand(command, env.cwd, 60_000, signal ?? new AbortController().signal);
      },
    }),
    defineTool({
      name: "list_files",
      label: "List Files",
      description: "List files in a directory using find, excluding .git and node_modules.",
      parameters: ListFilesParams,
      execute: async (_toolCallId: string, params: ListFilesParams, signal?: AbortSignal) => {
        const listPath = params.path ? resolveInsideCwd(env.cwd, params.path) : env.cwd;
        const command = `find ${JSON.stringify(listPath)} -maxdepth 2 -type f -not -path '*/.git/*' -not -path '*/node_modules/*' | sort | sed -n '1,200p'`;
        return runCommand(command, env.cwd, 30_000, signal ?? new AbortController().signal);
      },
    }),
  ];
}
