import { parkWorktree as parkTree, type ParkLocalBackingReader } from "@titan-design/worktree";
import { execSafeAsync, minimalEnv } from "../exec.js";
import type { MergedPrReader } from "./merged-pr.js";
import type { ParkTarget } from "./park-rules.js";
import { canonicalPath, isAtOrUnder } from "./paths.js";
import { dispatchIgnoredFiles } from "./unsaved-work.js";

/**
 * CC-282: park a finished agent's worktree. The tree is removed and the branch kept, so
 * `agent resume` re-creates it at the same path (CC-140). Parking never deletes a branch: in a
 * repo with no remote the local branch is the only copy of the work.
 */

/** A process and its working directory. */
export interface CwdProcess {
  pid: number;
  cwd: string;
}

/** Lists every process's cwd; throws when it cannot, which parking treats as a refusal. */
export type CwdLister = () => Promise<CwdProcess[]>;

/** Runs `lsof`, answering its exit status; rejects only when it could not run to an exit. */
export type LsofRunner = () => Promise<{ stdout: string; status: number }>;

const LSOF_TIMEOUT_MS = 30_000;

/** macOS keeps lsof in /usr/sbin, which `minimalEnv` leaves off PATH. */
const lsofEnv = (): Record<string, string> => {
  const env = minimalEnv();
  return { ...env, PATH: `${env.PATH}:/usr/sbin:/sbin` };
};

const runLsof: LsofRunner = () =>
  execSafeAsync("lsof", ["-a", "-d", "cwd", "-Fpn"], lsofEnv(), LSOF_TIMEOUT_MS);

function parseCwds(stdout: string): CwdProcess[] | undefined {
  const found: CwdProcess[] = [];
  let pid = 0;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid > 0) found.push({ pid, cwd: line.slice(1) });
  }
  return found.length > 0 ? found : undefined;
}

/**
 * `lsof -Fpn` prints `p<pid>` then `n<path>` per process. It exits 1 with no output when nothing
 * matches, and also when warnings accompany partial output, which still lists real processes.
 */
export const lsofCwdsWith =
  (run: LsofRunner): CwdLister =>
  async () => {
    const { stdout, status } = await run();
    if (status === 0) return parseCwds(stdout) ?? [];
    if (status === 1 && stdout === "") return [];
    const found = status === 1 ? parseCwds(stdout) : undefined;
    if (found === undefined) throw new Error(`lsof exited ${status}`);
    return found;
  };

export const lsofCwds: CwdLister = lsofCwdsWith(runLsof);

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** A detached agent's process may have outlived a broker restart, so refuse while anything still sits in its tree. */
async function occupiedByProcess(tree: string, list: CwdLister): Promise<string | undefined> {
  let procs: CwdProcess[];
  try {
    procs = await list();
  } catch (err) {
    return `could not check for processes running in ${tree} (${messageOf(err).split("\n")[0]}); not parked`;
  }
  const root = canonicalPath(tree);
  const inside = procs.find((p) => isAtOrUnder(canonicalPath(p.cwd), root));
  return inside && `process ${inside.pid} has its working directory in ${tree}; not parked while it runs`;
}

const DEFAULT_FETCH_MS = 30_000;

const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;

/**
 * CC-1064: GitHub's merged PRs on the branch HEAD is on, offered as local backing for a squash merge
 * whose head branch origin deleted. The package proves HEAD is in a candidate's local head commit and
 * reports its ref, which is the PR number; a malformed sha is dropped so the rest still count.
 */
const mergedPrBacking =
  (read: MergedPrReader, gitRoot: string): ParkLocalBackingReader =>
  async ({ branch }) =>
    (await read(gitRoot, branch).catch(() => []))
      .filter((pr) => OBJECT_ID.test(pr.headSha))
      .map((pr) => ({ oid: pr.headSha, ref: String(pr.number) }));

export type ParkTreeResult =
  | { ok: true; head: string; branch?: string; containedIn?: string; mergedPr?: number }
  | { ok: false; reason: string };

/**
 * Refuse a tree that would lose anything; otherwise remove it without --force and keep the branch.
 * HEAD may sit on the allocated branch or another local one (a successor or adopted tree on the PR
 * branch); origin must hold it under that name or any other, or a merged PR's head must, or with no
 * origin the kept local branch is the copy. `recheck` runs right before the removal, so a spawn or
 * resume that started meanwhile is caught.
 */
export async function parkWorktree(
  target: ParkTarget,
  recheck: () => string | undefined,
  /** Set for an untracked detached agent: the lister that finds a process still in the tree. */
  listCwds?: CwdLister,
  /** Set by the host: GitHub's merged PRs, for a squash-merged branch origin deleted. */
  mergedPr?: MergedPrReader,
): Promise<ParkTreeResult> {
  const occupied = listCwds && (await occupiedByProcess(target.worktree, listCwds));
  if (occupied) return { ok: false, reason: occupied };
  const options = {
    allowOriginHeadAncestor: true as const,
    allowDefaultBranchAncestor: true,
    fetchTimeoutMs: DEFAULT_FETCH_MS,
    ignoredFiles: dispatchIgnoredFiles,
  };
  if (mergedPr === undefined) return parkTree(target, recheck, options);
  const backing = mergedPrBacking(mergedPr, target.gitRoot);
  const result = await parkTree(target, recheck, { ...options, localBackingCandidates: backing });
  if (!result.ok) return result;
  const { backingRef, ...parked } = result;
  return backingRef === undefined ? parked : { ...parked, mergedPr: Number(backingRef) };
}
