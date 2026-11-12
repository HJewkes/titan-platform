import type { CheckRun, GitHubPort } from "@titan-design/github";

interface SharedRead {
  at: number;
  runs: Promise<readonly CheckRun[]>;
}

/**
 * Post-merge's per-repo ledger of main CI reads. Every run polling a repo's main shares one check-run read per sha per
 * `freshMs`, so several live runs on one tip cost what one does. A failed read is dropped, so the next poll reads again.
 */
export class MainCiReads {
  private readonly repos = new Map<string, Map<string, SharedRead>>();

  constructor(
    private readonly port: Pick<GitHubPort, "checkRuns">,
    private readonly now: () => number,
    private readonly freshMs: number,
  ) {}

  async checkRuns(repo: string, sha: string): Promise<CheckRun[]> {
    const reads = this.ledgerOf(repo);
    const now = this.now();
    for (const [key, read] of reads) if (now - read.at >= this.freshMs) reads.delete(key);
    let read = reads.get(sha);
    if (read === undefined) {
      const fresh: SharedRead = { at: now, runs: this.port.checkRuns(repo, sha) };
      fresh.runs.catch(() => reads.get(sha) === fresh && reads.delete(sha));
      reads.set(sha, (read = fresh));
    }
    return [...(await read.runs)];
  }

  /** `port` with its check-run reads answered through this ledger. */
  over(port: GitHubPort): GitHubPort {
    return { ...port, checkRuns: (repo, sha) => this.checkRuns(repo, sha) };
  }

  private ledgerOf(repo: string): Map<string, SharedRead> {
    const key = repo.toLowerCase();
    let reads = this.repos.get(key);
    if (reads === undefined) this.repos.set(key, (reads = new Map()));
    return reads;
  }
}
