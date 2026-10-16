import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Refuses an out dir inside any git work tree, so a private case can never be committed by accident. */
export async function assertOutsideWorkTree(outDir: string): Promise<void> {
  let probe = resolve(outDir);
  while (!existsSync(probe)) probe = dirname(probe);
  const inside = await run("git", ["-C", probe, "rev-parse", "--is-inside-work-tree"]).then(
    ({ stdout }) => stdout.trim() === "true",
    () => false,
  );
  if (inside) throw new Error(`--out ${outDir} is inside a git work tree; private cases must be written outside every repo`);
}

export function assertFreshOut(outDir: string): void {
  if (existsSync(outDir) && readdirSync(outDir).length > 0) throw new Error(`--out ${outDir} is not empty; build into a fresh directory`);
}
