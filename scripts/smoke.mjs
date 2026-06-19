import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getModels } from "@earendil-works/pi-ai";
import { resolveInsideCwd } from "../dist/pathSafety.js";
import { createCodingTools } from "../dist/tools.js";

const cwd = await mkdtemp(path.join(tmpdir(), "pi-claude-min-"));

try {
  await writeFile(path.join(cwd, "README.md"), "# smoke\nhello\n", "utf8");

  assert.equal(
    getModels("anthropic").some(model => model.id === "claude-sonnet-4-20250514"),
    true,
    "default Anthropic model should be present in pi-ai registry",
  );

  assert.throws(() => resolveInsideCwd(cwd, "../outside.txt"), /Path escapes cwd/);

  const tools = createCodingTools({ cwd, maxReadBytes: 1000 });
  assert.deepEqual(
    tools.map(tool => tool.name),
    ["read_file", "write_file", "edit_file", "bash", "grep", "list_files"],
  );

  const readFileTool = tools.find(tool => tool.name === "read_file");
  assert.ok(readFileTool);
  const readResult = await readFileTool.execute("read-1", { path: "README.md" });
  assert.equal(readResult.content[0]?.type, "text");
  assert.match(readResult.content[0]?.text ?? "", /# smoke/);

  const editFileTool = tools.find(tool => tool.name === "edit_file");
  assert.ok(editFileTool);
  await editFileTool.execute("edit-1", {
    path: "README.md",
    oldText: "hello",
    newText: "world",
  });
  assert.match(await readFile(path.join(cwd, "README.md"), "utf8"), /world/);

  console.log("smoke ok");
} finally {
  await rm(cwd, { recursive: true, force: true });
}
