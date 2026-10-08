import type { GitHubPort, PullRequest, RepoSlug } from "@titan-design/github";
import type { TickPacing } from "../tick-pacing.js";
import type { PrSnapshot } from "../workflows/pr-snapshot.js";

/** What the sweeps and `/health` read beyond the port. */
export interface SnapshotServices {
  /** The per-repo PR snapshot the gone and release sweeps read; absent means they read the port. */
  snapshot?: PrSnapshot;
  /** How fast the snapshot ticks, for `/health`. */
  pacing?: TickPacing;
}

/**
 * A PR for a wait or a sweep: its row on the repo's open list when it has one, else a read through the port, which is how a
 * merged, closed or deleted PR shows. A row up to one tick old only delays what the caller does; a write re-reads its PR.
 */
export async function openOrRead(port: GitHubPort, snapshot: PrSnapshot | undefined, repo: RepoSlug, number: number): Promise<PullRequest> {
  const row = snapshot && (await snapshot.openPrs(repo)).find((pr) => pr.number === number);
  return row ?? port.getPr(repo, number);
}

/** The open PR on `headBranch` of the repo itself, or null: `findPr` asks GitHub for same-repo heads only, so a fork's branch of that name is no match. With a snapshot a closed one is not looked for, since no caller acts on it. */
export async function openOnBranch(port: GitHubPort, snapshot: PrSnapshot | undefined, repo: RepoSlug, headBranch: string): Promise<PullRequest | null> {
  if (!snapshot) return port.findPr(repo, headBranch);
  const rows = await snapshot.openPrs(repo);
  return rows.filter((pr) => pr.headRef === headBranch && pr.headRepo?.toLowerCase() === repo.toLowerCase()).sort((a, b) => b.number - a.number)[0] ?? null;
}
