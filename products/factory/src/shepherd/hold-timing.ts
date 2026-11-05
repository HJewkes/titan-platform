import type { RepoSlug } from "@titan-design/github";

export const HOLD_POLL_MS = 10_000;

/**
 * Why a merge of `repo#pr` at `sha` must wait, read fresh; a PR merged or closed elsewhere has nothing left to wait for; any
 * other state, unknown included, keeps the hold. A hold satisfied at `sha` passes only while `sha` is still the head; no
 * `sha` means the head as read now.
 */
export type HeldCheck = (repo: RepoSlug, pr: number, sha?: string) => Promise<string | undefined>;

export interface HoldTiming {
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  pollMs?: number;
  now?: () => number;
}

/** True once when the run's g10 release at `sha` must be asked again, which only the run's own CI read can do. */
export type TakeRecheck = (repo: RepoSlug, pr: number, sha: string) => boolean;
