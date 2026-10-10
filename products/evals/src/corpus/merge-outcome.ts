import { rangesOverlap } from "@titan-design/evidence";
import type { GitPort, MainCommit } from "./git.js";
import { LABEL_MATURITY_MS } from "./labels.js";

export interface MergeOutcome {
  revert: boolean | null;
  laterFix: boolean | null;
}

const UNKNOWN: MergeOutcome = { revert: null, laterFix: null };
const FIX_SUBJECT = /\bfix(?:e[sd])?\b/i;

function isRevertOf(commit: MainCommit, merged: MainCommit): boolean {
  return commit.body.includes(`This reverts commit ${merged.sha}`) || commit.subject.startsWith(`Revert "${merged.subject}"`);
}

/**
 * A fix within the window whose removed or replaced lines overlap lines the merge wrote, in the same file. Line numbers are
 * compared as recorded, without following drift from commits in between; the plan accepts that for a 14-day window.
 */
function laterFix(git: GitPort, merged: MainCommit, newer: readonly MainCommit[]): boolean | null {
  const written = git.hunks(merged.sha)?.newSide;
  if (!written) return null;
  const windowEnd = merged.time * 1000 + LABEL_MATURITY_MS;
  const fixes = newer.filter((commit) => commit.time * 1000 <= windowEnd && FIX_SUBJECT.test(commit.subject));
  return fixes.some((fix) => (git.hunks(fix.sha)?.oldSide ?? []).some((range) => written.some((line) => rangesOverlap(range, line))));
}

/** Revert and later-fix for a merge commit on the main ref; unknown when the clone does not hold it on that ref. */
export function mergeOutcome(git: GitPort, mergeSha: string): MergeOutcome {
  const log = git.mainLog();
  const index = log.findIndex((commit) => commit.sha === mergeSha);
  const merged = log[index];
  if (index < 0 || !merged) return UNKNOWN;
  const newer = log.slice(0, index);
  return { revert: newer.some((commit) => isRevertOf(commit, merged)), laterFix: laterFix(git, merged, newer) };
}
