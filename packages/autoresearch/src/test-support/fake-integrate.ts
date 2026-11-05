import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { IntegrateRequest, IntegrateResult } from "../ports.js";

const run = promisify(execFile);
const IDENTITY = ["-c", "user.name=autoresearch fixture", "-c", "user.email=fixture@example.invalid"];
const git = async (cwd: string, ...args: string[]) => (await run("git", [...IDENTITY, ...args], { cwd })).stdout.trim();

/** The date a merge gets when the test host passes no step timing. */
const FIXTURE_AT = "2026-10-21T00:00:00Z";

/** A later winner merged onto the base in a detached checkout, never pushed; a conflict is aborted and named. */
export async function fakeMergeOnto({ tree, base, head, message, at = FIXTURE_AT }: IntegrateRequest): Promise<IntegrateResult> {
  await git(tree, "checkout", "--quiet", "--detach", base);
  const env = { ...process.env, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at };
  const merged = await run("git", [...IDENTITY, "merge", "--no-ff", "--no-edit", "-m", message, head], { cwd: tree, env }).then(() => true, () => false);
  if (merged) return { merged: await git(tree, "rev-parse", "HEAD") };
  const conflict = (await git(tree, "diff", "--name-only", "--diff-filter=U")).split("\n").filter(Boolean);
  await git(tree, "merge", "--abort");
  return { conflict };
}
