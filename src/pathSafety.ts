import path from "node:path";

export function resolveInsideCwd(cwd: string, inputPath: string): string {
  const resolved = path.resolve(cwd, inputPath);
  const relative = path.relative(cwd, resolved);

  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return resolved;
  }

  throw new Error(`Path escapes cwd: ${inputPath}`);
}

export function displayPath(cwd: string, absolutePath: string): string {
  const relative = path.relative(cwd, absolutePath);
  return relative || ".";
}
