import { ciVerdict, loadRequiredContexts, type CiVerdict } from "./ci-verdict.js";
import type { GitHubPort, RepoSlug, RequiredChecks } from "./port-types.js";

export interface CiWaitOptions {
  repo: RepoSlug;
  /** Seven to 40 lower-case hex characters; an abbreviation is expanded before the first poll. */
  sha: string;
  /** The branch whose required contexts apply; the repo's default branch when absent. */
  base?: string;
  timeoutSeconds: number;
  intervalSeconds: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Told of each failed read, which is retried on the next poll and never decides the outcome. */
  onReadError?: (error: unknown) => void;
}

export type CiWaitOutcome = "green" | "red" | "timeout" | "unknown-sha";

/** `line` is what `ci-wait` prints: on stdout for green, red and timeout, on stderr for an unknown sha. */
export interface CiWaitResult {
  outcome: CiWaitOutcome;
  line: string;
}

interface PollState {
  sha: string;
  resolved: boolean;
  /** The default branch, resolved on the first poll: it does not change mid-wait. */
  base: string | null;
  /** The last list read successfully. */
  rules: RequiredChecks | null;
}

/**
 * Polls until the sha's CI is green or red, or the next poll would pass the deadline. The required contexts
 * are re-read on every poll; a failed read, or one that comes back empty after a list was recorded, keeps the
 * last list. A sha GitHub does not have ends at once, because its status would read pending forever.
 */
export async function ciWait(port: GitHubPort, options: CiWaitOptions): Promise<CiWaitResult> {
  const { repo, timeoutSeconds, intervalSeconds, now, sleep } = options;
  const state: PollState = { sha: options.sha, resolved: false, base: options.base ?? null, rules: null };
  const start = now();
  let pending = "(no successful poll)";
  for (;;) {
    const verdict = await attempt(options, () => poll(port, options, state));
    if (verdict === "unknown-sha") return { outcome: "unknown-sha", line: `need a full 40-hex sha of a pushed commit: no commit ${options.sha} in ${repo}` };
    if (verdict?.verdict === "green") return { outcome: "green", line: `GREEN ${repo} ${state.sha}` };
    if (verdict?.verdict === "red") return { outcome: "red", line: `RED ${repo} ${state.sha}: ${verdict.reasons.join("; ")}` };
    if (verdict) pending = verdict.reasons.join(", ");
    const elapsed = Math.floor((now() - start) / 1000);
    if (elapsed + intervalSeconds > timeoutSeconds) return { outcome: "timeout", line: `TIMEOUT ${repo} ${state.sha} after ${elapsed}s: pending ${pending}` };
    await sleep(intervalSeconds * 1000);
  }
}

async function attempt<T>(options: CiWaitOptions, read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (error) {
    options.onReadError?.(error);
    return null;
  }
}

async function poll(port: GitHubPort, options: CiWaitOptions, state: PollState): Promise<CiVerdict | "unknown-sha"> {
  const { repo } = options;
  if (!state.resolved) {
    const full = await port.resolveCommit(repo, state.sha);
    if (full === null) return "unknown-sha";
    if (!full.startsWith(state.sha)) throw new Error(`GitHub expanded ${state.sha} to ${full}, which it does not abbreviate`);
    state.sha = full;
    state.resolved = true;
  }
  state.rules = await currentRules(port, options, state);
  const [runs, statuses] = await Promise.all([port.checkRuns(repo, state.sha), port.commitStatuses(repo, state.sha)]);
  return ciVerdict({ rules: state.rules, runs, statuses });
}

async function currentRules(port: GitHubPort, options: CiWaitOptions, state: PollState): Promise<RequiredChecks> {
  state.base ??= await port.defaultBranch(options.repo);
  const recorded = state.rules;
  try {
    const live = await loadRequiredContexts(port, options.repo, state.base);
    return recorded && recorded.contexts.length > 0 && live.contexts.length === 0 ? recorded : live;
  } catch (error) {
    if (!recorded) throw error;
    options.onReadError?.(error);
    return recorded;
  }
}
