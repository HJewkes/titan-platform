import type { GitHubPort, RepoSlug } from "@titan-design/github";
import { mergeOnto } from "./integrate.js";
import { ratchetFastForward } from "./ratchet.js";
import { isAncestor, type DatedGit } from "./snapshot.js";

interface SyncInput {
  repo: RepoSlug;
  /** The open snapshot PR. */
  pr: number;
  /** The integration tree: a checkout of the target repo whose `origin` holds the ratchet. */
  tree: string;
  /** The ratchet head the round would start from. */
  head: string;
  ratchetRef: string;
  ratchetPrefix: string;
  defaultBranch: string;
  /** The target's frozen globs, as git `:(glob)` pathspecs. */
  frozen: readonly string[];
  /** The snapshot log directory; a sync that brings in only logs leaves the measured tree unchanged. */
  logDir: string;
  /** The step's first start: the merge commit's dates, so a restarted sync rebuilds the same sha. */
  at: string;
  /** A gate's answer: a commit the owner or seat built that holds both the ratchet head and main's tip. */
  resolved?: string;
}

type SyncResult =
  | { state: "open" | "closed" }
  | { state: "merged"; merged: { from: string; to: string; main: string }; treeChanged: boolean }
  | { state: "merged"; conflict: string[] }
  | { state: "merged"; frozen: string[] };

async function fetchMain(git: DatedGit, { tree, defaultBranch }: SyncInput): Promise<string> {
  await git(["fetch", "--quiet", "origin"], tree).catch((error: unknown) => {
    throw new Error(`[pin-fetch] git fetch origin failed in ${tree}: ${error instanceof Error ? error.message : String(error)}`);
  });
  return git(["rev-parse", `refs/remotes/origin/${defaultBranch}`], tree);
}

/** A gate's answer is taken only when it already contains both sides, so it can only add to the ratchet's history. */
async function acceptResolved(git: DatedGit, input: SyncInput, resolved: string, main: string): Promise<void> {
  if (!/^[0-9a-f]{40}$/.test(resolved)) throw new Error(`[sync-resolved] ${resolved} is not a full commit sha`);
  for (const side of [input.head, main]) {
    if (!(await isAncestor(git, input.tree, side, resolved))) throw new Error(`[sync-resolved] ${resolved} does not contain ${side}`);
  }
}

async function frozenChanges(git: DatedGit, { tree, head, frozen }: SyncInput, merged: string): Promise<string[]> {
  if (frozen.length === 0) return [];
  const pathspecs = frozen.map((glob) => `:(glob)${glob}`);
  return (await git(["diff", "--name-only", head, merged, "--", ...pathspecs], tree)).split("\n").filter(Boolean);
}

/** Exit 1 is "differs"; the log directory is excluded because every snapshot PR adds to it. */
async function treeChanged(git: DatedGit, { tree, head, logDir }: SyncInput, merged: string): Promise<boolean> {
  return git(["diff", "--quiet", head, merged, "--", ".", `:(exclude)${logDir}`], tree).then(
    () => false,
    (error: { code?: unknown }) => {
      if (error.code === 1) return true;
      throw error;
    },
  );
}

/**
 * After the snapshot PR merges, merges main into the ratchet so the next PR diffs only new work. The ratchet only
 * gains history: the merge has the old head as its first parent and moves by the leased fast-forward. A conflict or a
 * frozen change is returned, not thrown, so the recipe holds the loop at its assisted gate and nothing is pushed.
 */
export async function syncRatchet(git: DatedGit, port: Pick<GitHubPort, "getPr">, input: SyncInput): Promise<SyncResult> {
  const pr = await port.getPr(input.repo, input.pr);
  if (!pr.merged) return { state: pr.state };
  const main = await fetchMain(git, input);
  let to = input.resolved;
  if (to !== undefined) await acceptResolved(git, input, to, main);
  else {
    const result = await mergeOnto(git, { tree: input.tree, base: input.head, head: main, message: `ar: merge ${input.defaultBranch} into ${input.ratchetRef}`, at: input.at });
    if ("conflict" in result) return { state: "merged", conflict: result.conflict };
    if (!("merged" in result)) throw new Error(`[sync-merge] merging ${main} into ${input.head} made no commit`);
    to = result.merged;
    const frozen = await frozenChanges(git, input, to);
    if (frozen.length > 0) return { state: "merged", frozen };
  }
  const changed = await treeChanged(git, input, to);
  const { head } = await ratchetFastForward(git, { tree: input.tree, ratchetRef: input.ratchetRef, ratchetPrefix: input.ratchetPrefix, defaultBranch: input.defaultBranch, from: input.head, to });
  return { state: "merged", merged: { from: input.head, to: head, main }, treeChanged: changed };
}
