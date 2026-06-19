#!/usr/bin/env node
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { createCodingAgentSession } from "./agent.js";
import { createSessionStore, getSessionPath, loadLatestSnapshot, sessionExists } from "./session.js";
import type { CliOptions, PermissionMode } from "./types.js";

function printHelp(): void {
  process.stdout.write(`pi-claude-min

Clean-room minimal Claude Code style agent built on Pi.

Usage:
  pi-claude-min [options] "fix the failing test"
  pi-claude-min [options]

Options:
  --provider <name>        LLM provider (default: anthropic, env: PI_PROVIDER)
  --model <id>             Model id (default: claude-sonnet-4-20250514, env: PI_MODEL)
  --cwd <path>             Working directory (default: current directory)
  --print                  Print-mode output without extra interactive chrome
  --json                   Emit JSONL event stream
  --session <id>           Use a specific session id
  --resume <id>            Continue writing to an existing session file
  --yes                    Auto-approve sensitive tools for this run
  --dangerously-skip-permissions
                           Bypass all tool approval prompts
  --max-read-bytes <n>     Max bytes read per read_file call (default: 200000)
  -h, --help               Show this help

Interactive commands:
  /help                    Show interactive commands
  /model                   Show active provider/model
  /session                 Show session details
  /tools                   Show available tools
  /clear                   Clear in-memory conversation context
  /exit                    Quit

Environment:
  ANTHROPIC_API_KEY, OPENAI_API_KEY, etc. are resolved by @earendil-works/pi-ai.
`);
}

function takeValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function parseArgs(argv: string[]): { cli: CliOptions; prompt: string } {
  const rest: string[] = [];
  let provider = process.env.PI_PROVIDER ?? "anthropic";
  let model = process.env.PI_MODEL ?? "claude-sonnet-4-20250514";
  let cwd = process.cwd();
  let print = false;
  let json = false;
  let session: string | undefined;
  let resume: string | undefined;
  let permissionMode: PermissionMode = "ask";
  let maxReadBytes = 200_000;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      printHelp();
      process.exit(0);
    }
    if (arg === "--provider") {
      provider = takeValue(argv, i, arg);
      i += 1;
      continue;
    }
    if (arg === "--model") {
      model = takeValue(argv, i, arg);
      i += 1;
      continue;
    }
    if (arg === "--cwd") {
      cwd = path.resolve(takeValue(argv, i, arg));
      i += 1;
      continue;
    }
    if (arg === "--session") {
      session = takeValue(argv, i, arg);
      i += 1;
      continue;
    }
    if (arg === "--resume") {
      resume = takeValue(argv, i, arg);
      i += 1;
      continue;
    }
    if (arg === "--max-read-bytes") {
      maxReadBytes = Number.parseInt(takeValue(argv, i, arg), 10);
      if (!Number.isFinite(maxReadBytes) || maxReadBytes <= 0) {
        throw new Error("--max-read-bytes must be a positive integer");
      }
      i += 1;
      continue;
    }
    if (arg === "--print") {
      print = true;
      continue;
    }
    if (arg === "--json") {
      json = true;
      print = true;
      continue;
    }
    if (arg === "--yes") {
      permissionMode = "auto";
      continue;
    }
    if (arg === "--dangerously-skip-permissions") {
      permissionMode = "bypass";
      continue;
    }
    rest.push(arg);
  }

  return {
    cli: {
      cwd,
      provider,
      model,
      print,
      json,
      resume,
      session,
      permissionMode,
      maxReadBytes,
    },
    prompt: rest.join(" ").trim(),
  };
}

async function readPromptFromStdin(): Promise<string> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString("utf8").trim();
  }

  const rl = readline.createInterface({ input, output });
  try {
    return (await rl.question("> ")).trim();
  } finally {
    rl.close();
  }
}

function printInteractiveHelp(): void {
  process.stdout.write(`Commands:
  /help      Show this help
  /model     Show active provider/model
  /session   Show session details
  /tools     Show available tools
  /clear     Clear conversation context
  /exit      Quit
`);
}

async function runInteractive(cli: CliOptions, initialMessages?: unknown[]): Promise<void> {
  const session = await createSessionStore(cli.resume ?? cli.session);
  const runner = await createCodingAgentSession({ cli, session, initialMessages });
  const rl = readline.createInterface({ input, output, prompt: "> " });

  process.stdout.write("pi-claude-min interactive mode. Type /help for commands.\n");
  process.stdout.write(`${runner.describe()}\n\n`);
  rl.prompt();

  for await (const line of rl) {
    const prompt = line.trim();
    if (!prompt) {
      rl.prompt();
      continue;
    }

    if (prompt === "/exit" || prompt === "/quit") {
      break;
    }
    if (prompt === "/help") {
      printInteractiveHelp();
      rl.prompt();
      continue;
    }
    if (prompt === "/model") {
      process.stdout.write(`${cli.provider}/${cli.model}\n`);
      rl.prompt();
      continue;
    }
    if (prompt === "/session" || prompt === "/tools") {
      process.stdout.write(`${runner.describe()}\n`);
      rl.prompt();
      continue;
    }
    if (prompt === "/clear") {
      await runner.clear();
      process.stdout.write("context cleared\n");
      rl.prompt();
      continue;
    }
    if (prompt.startsWith("/")) {
      process.stdout.write(`Unknown command: ${prompt}\n`);
      rl.prompt();
      continue;
    }

    await runner.prompt(prompt);
    rl.prompt();
  }

  rl.close();
}

async function main(): Promise<void> {
  const { cli, prompt: parsedPrompt } = parseArgs(process.argv.slice(2));
  if (cli.resume && !(await sessionExists(cli.resume))) {
    throw new Error(`Cannot resume missing session ${cli.resume} at ${getSessionPath(cli.resume)}`);
  }

  const initialMessages = cli.resume ? await loadLatestSnapshot(cli.resume) : undefined;

  if (!parsedPrompt && process.stdin.isTTY) {
    await runInteractive(cli, initialMessages);
    return;
  }

  const prompt = parsedPrompt || (await readPromptFromStdin());
  if (!prompt) {
    printHelp();
    process.exitCode = 1;
    return;
  }

  const session = await createSessionStore(cli.resume ?? cli.session);
  const runner = await createCodingAgentSession({ cli, session, initialMessages });
  await runner.prompt(prompt);
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
