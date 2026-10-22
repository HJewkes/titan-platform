import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { IntegrateResult } from "@titan-design/autoresearch";

type DatedGit = (args: readonly string[], cwd: string, env?: Readonly<Record<string, string>>) => Promise<string>;

const run = promisify(execFile);

export const execDatedGit: DatedGit = async (args, cwd, env = {}) => (await run("git", [...args], { cwd, env: { ...process.env, ...env } })).stdout.trim();

const SHA = /^[0-9a-f]{40}$/;
const IDENTITY = ["-c", "user.name=autoresearch", "-c", "user.email=autoresearch@example.invalid"];

export interface MergeOnto {
  /** The run's integration tree; its HEAD is left detached at the merge, or at `base` after a conflict. */
  tree: string;
  base: string;
  head: string;
  message: string;
  /** The step's first start: author and committer date, so a restarted step rebuilds the same sha. */
  at?: string;
}

/**
 * Merges `head` onto `base` in a detached checkout, never pushing. `base` is checked out first whatever an earlier
 * step left there. A conflict is aborted, so the tree is clean, and named; any other failure is thrown.
 */
export async function mergeOnto(git: DatedGit, { tree, base, head, message, at }: MergeOnto): Promise<IntegrateResult> {
  if (!SHA.test(base) || !SHA.test(head)) throw new Error(`[integrate-sha] ${base} and ${head} must both be full commit shas`);
  if (at === undefined || Number.isNaN(Date.parse(at))) throw new Error(`[integrate-at] ${at ?? "no first start"} cannot date the merge`);
  await git(["checkout", "--quiet", "--detach", base], tree);
  const merging = git([...IDENTITY, "merge", "--no-ff", "--no-edit", "-m", message, head], tree, { GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at });
  const failure = await merging.then(() => undefined, (error: unknown) => error);
  if (failure === undefined) return { merged: await git(["rev-parse", "HEAD"], tree) };
  const conflict = (await git(["diff", "--name-only", "--diff-filter=U"], tree)).split("\n").filter(Boolean);
  if (conflict.length === 0) throw failure;
  await git(["merge", "--abort"], tree);
  return { conflict };
}
