import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import type { PermissionMode } from "./types.js";

const WRITE_TOOLS = new Set(["write_file", "edit_file", "bash"]);

export function isSensitiveTool(name: string): boolean {
  return WRITE_TOOLS.has(name);
}

export async function approveToolCall(options: {
  mode: PermissionMode;
  toolName: string;
  args: unknown;
}): Promise<{ allow: boolean; reason?: string }> {
  if (!isSensitiveTool(options.toolName)) {
    return { allow: true };
  }

  if (options.mode === "bypass" || options.mode === "auto") {
    return { allow: true };
  }

  if (!process.stdin.isTTY) {
    return {
      allow: false,
      reason: `Tool ${options.toolName} requires approval in non-interactive mode. Use --yes or --dangerously-skip-permissions.`,
    };
  }

  const rl = readline.createInterface({ input, output });
  try {
    output.write(`\nTool request: ${options.toolName}\n`);
    output.write(`${JSON.stringify(options.args, null, 2)}\n`);
    const answer = await rl.question("Allow this tool call? [y/N] ");
    const normalized = answer.trim().toLowerCase();
    if (normalized === "y" || normalized === "yes") {
      return { allow: true };
    }
    return { allow: false, reason: "User denied tool call." };
  } finally {
    rl.close();
  }
}
