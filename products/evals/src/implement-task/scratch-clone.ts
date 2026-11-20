import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Exec } from "@titan-design/fix-proof";

const CLONE_TIMEOUT_MS = 10 * 60_000;
const REPO_NAME = /^[\w-][\w.-]*\/[\w-][\w.-]*$/;

interface ScratchCloneRequest {
  repo: string;
  outDir: string;
  exec: Exec;
  /** Resolved only when the scratch clone does not exist yet. */
  sourceOf(): string;
}

/** The `.scratch/<owner>/<repo>` clone of the owner's repo, so a screen never writes into the owner's clone. */
export async function ensureScratchClone({ repo, outDir, exec, sourceOf }: ScratchCloneRequest): Promise<string> {
  if (!REPO_NAME.test(repo)) throw new Error(`repo is not owner/name: ${JSON.stringify(repo)}`);
  const clone = join(outDir, ".scratch", repo);
  if (existsSync(clone)) return clone;
  const source = sourceOf();
  mkdirSync(dirname(clone), { recursive: true });
  const result = await exec("git", ["clone", "--quiet", "--shared", "--no-checkout", "--", source, clone], { cwd: dirname(clone), timeoutMs: CLONE_TIMEOUT_MS });
  if (result.status !== 0) throw new Error(`scratch clone of ${repo} failed (exit ${result.status ?? "signal"}): ${result.stderr.trim()}`);
  return clone;
}
