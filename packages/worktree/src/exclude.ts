import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { gitOrNull } from "./git.js";

/** A base path that stays inside the repository can be rooted in an exclude pattern; anything else cannot. */
function excludeLineFor(basePath: string): string | undefined {
  const trimmed = basePath.replace(/^(\.\/)+/, "").replace(/\/+$/, "");
  if (trimmed === "" || path.isAbsolute(trimmed) || trimmed.split("/").includes("..")) return undefined;
  return `/${trimmed}/`;
}

/**
 * Keep the worktree base out of the primary's `git status` by appending it to
 * `<git-common-dir>/info/exclude`, which is local to the clone and never committed.
 *
 * `--git-common-dir` so an allocation run from inside a worktree writes the primary's
 * file, not that worktree's private gitdir. Idempotent; existing lines are kept. Returns a
 * warning instead of throwing when the file cannot be written.
 */
export async function ensureBaseExcluded(cwd: string, basePath: string): Promise<string | undefined> {
  const line = excludeLineFor(basePath);
  if (line === undefined) return undefined;
  const commonDir = await gitOrNull(["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd);
  if (commonDir === null) return undefined;
  const file = path.join(commonDir, "info", "exclude");
  try {
    const current = existsSync(file) ? readFileSync(file, "utf8") : "";
    if (current.split("\n").includes(line)) return undefined;
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, `${current === "" || current.endsWith("\n") ? "" : "\n"}${line}\n`);
    return undefined;
  } catch (error) {
    // The exclude file only keeps git status tidy, so a write failure must not fail the allocation.
    return `could not write ${file}: ${error instanceof Error ? error.message : String(error)}`;
  }
}
