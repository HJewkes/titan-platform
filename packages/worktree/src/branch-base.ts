import { gitOrNull } from "./git.js";

/** The commit a new branch is cut from, the ref it was read from, and a warning when that ref is not origin's. */
export interface BranchBase {
  sha: string;
  ref: string;
  warning?: string;
}

/** origin/HEAD when this clone knows it; otherwise the two conventional names, in order. */
async function defaultBranchCandidates(gitRoot: string): Promise<string[]> {
  const head = await gitOrNull(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], gitRoot);
  return head?.startsWith("origin/") ? [head.slice("origin/".length)] : ["main", "master"];
}

/** Fetch only: it moves a remote-tracking ref and never the main checkout's HEAD or files. */
export async function fetchTip(gitRoot: string, branch: string, timeoutMs: number): Promise<string | null> {
  const tracking = `refs/remotes/origin/${branch}`;
  const fetched = await gitOrNull(
    ["fetch", "--quiet", "--no-tags", "origin", `+refs/heads/${branch}:${tracking}`],
    gitRoot,
    timeoutMs
  );
  return fetched === null ? null : gitOrNull(["rev-parse", "--verify", `${tracking}^{commit}`], gitRoot);
}

/** The timeout is one budget shared by every candidate, not one per candidate. */
async function fetchDefaultTip(gitRoot: string, timeoutMs: number): Promise<BranchBase | string> {
  if ((await gitOrNull(["remote", "get-url", "origin"], gitRoot)) === null)
    return "the repository has no origin remote";
  const deadline = Date.now() + timeoutMs;
  const candidates = await defaultBranchCandidates(gitRoot);
  for (const branch of candidates) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const sha = await fetchTip(gitRoot, branch, remaining);
    if (sha !== null) return { sha, ref: `origin/${branch}` };
  }
  return `fetching ${candidates.map((b) => `origin/${b}`).join(" or ")} failed or timed out`;
}

/** Concurrent fetches of one ref race on its lock and the loser fails, so allocations in a repo share one. */
const inflightBases = new Map<string, Promise<BranchBase>>();

/**
 * The main checkout's HEAD may lag origin or hold another session's unpushed
 * commits, and a branch cut from it ships both. So cut from a fresh fetch of
 * origin's default branch, and say so loudly when that is impossible.
 */
export function resolveBranchBase(gitRoot: string, timeoutMs: number): Promise<BranchBase> {
  const pending = inflightBases.get(gitRoot);
  if (pending !== undefined) return pending;
  const resolving = resolveBranchBaseNow(gitRoot, timeoutMs).finally(() => inflightBases.delete(gitRoot));
  inflightBases.set(gitRoot, resolving);
  return resolving;
}

async function resolveBranchBaseNow(gitRoot: string, timeoutMs: number): Promise<BranchBase> {
  const reason = await fetchDefaultTip(gitRoot, timeoutMs);
  if (typeof reason !== "string") return reason;
  const sha = (await gitOrNull(["rev-parse", "HEAD"], gitRoot)) ?? "HEAD";
  return {
    sha,
    ref: "HEAD",
    warning:
      `worktree branched from the local HEAD at ${sha} because ${reason}; ` +
      "it may lag origin or carry unpushed commits",
  };
}
