import { z } from "zod";

/** One reviewer verdict message, as agent-chat's events table records it. */
export interface VerdictRecord {
  eventId: number;
  at: string;
  /** The seat the verdict was sent to. */
  seat: string;
  reviewer: string;
  verdict: string;
  repo: string;
  pr: number;
  head: string;
}

/** A PR as GitHub REST reports it at the time of the run. */
export interface PullState {
  repo: string;
  pr: number;
  state: "open" | "closed";
  mergedAt: string | null;
  headSha: string;
}

export type ParsedVerdict = Pick<VerdictRecord, "verdict" | "repo" | "pr" | "head">;

const VERDICT_LINE = /^Verdict:\s*([A-Z_]+)/;
const PR_LINE = /^PR:\s*(?:https:\/\/github\.com\/)?([\w.-]+\/[\w.-]+)(?:#|\/pull\/)(\d+)/m;
const HEAD_LINE = /^Head:\s*`?([0-9a-f]{7,40})\b/m;

/** Reads a `Verdict:` message's first three lines; null when any of them is missing. */
export function parseVerdict(body: string): ParsedVerdict | null {
  const verdict = VERDICT_LINE.exec(body)?.[1];
  const pr = PR_LINE.exec(body);
  const head = HEAD_LINE.exec(body)?.[1];
  if (!verdict || !pr || !head) return null;
  return { verdict, repo: pr[1]!, pr: Number(pr[2]), head };
}

export type MergeStatus = "merged" | "open" | "stale-head" | "closed" | "unknown";

/** A PR holding at least one MERGE verdict, resolved against its GitHub state at `asOf`. */
export interface MergeOutcome {
  repo: string;
  pr: number;
  status: MergeStatus;
  /** The first MERGE verdict at the PR's final head; null when no verdict names that head. */
  verdict: VerdictRecord | null;
  /** Verdict to merge for merged PRs; verdict to `asOf` (a censored age) for open ones. */
  minutes: number | null;
}

const MINUTE_MS = 60_000;

export function mergeOutcomes(verdicts: readonly VerdictRecord[], pulls: readonly PullState[], asOf: string): MergeOutcome[] {
  const byPr = new Map<string, VerdictRecord[]>();
  for (const v of verdicts) if (v.verdict === "MERGE") byPr.set(prKey(v), [...(byPr.get(prKey(v)) ?? []), v]);
  const pullByKey = new Map(pulls.map((p) => [prKey(p), p]));
  return [...byPr.values()].map((held) => outcome(held, pullByKey.get(prKey(held[0]!)), asOf));
}

export function prKey(row: { repo: string; pr: number }): string {
  return `${row.repo}#${row.pr}`;
}

function outcome(held: VerdictRecord[], pull: PullState | undefined, asOf: string): MergeOutcome {
  const { repo, pr } = held[0]!;
  if (!pull) return { repo, pr, status: "unknown", verdict: null, minutes: null };
  const atHead = held.filter((v) => sameSha(v.head, pull.headSha)).sort((a, b) => a.at.localeCompare(b.at))[0];
  const mergedBy = pull.mergedAt !== null && pull.mergedAt <= asOf;
  if (!atHead) return { repo, pr, status: pull.mergedAt !== null || pull.state === "open" ? "stale-head" : "closed", verdict: null, minutes: null };
  if (mergedBy) return { repo, pr, status: "merged", verdict: atHead, minutes: Math.max(0, minutesBetween(atHead.at, pull.mergedAt!)) };
  if (pull.state === "open" || pull.mergedAt !== null) return { repo, pr, status: "open", verdict: atHead, minutes: minutesBetween(atHead.at, asOf) };
  return { repo, pr, status: "closed", verdict: atHead, minutes: null };
}

function sameSha(a: string, b: string): boolean {
  return a.startsWith(b) || b.startsWith(a);
}

function minutesBetween(from: string, to: string): number {
  return (Date.parse(to) - Date.parse(from)) / MINUTE_MS;
}

const minutes = z.number().nullable();

export const latencyStatsSchema = z.object({
  merged: z.number().int().nonnegative(),
  medianMin: minutes,
  meanMin: minutes,
  p90Min: minutes,
  maxMin: minutes,
  /** Open PRs holding MERGE at their current head; their ages are lower bounds on the wait. */
  censored: z.number().int().nonnegative(),
  oldestCensoredMin: minutes,
  censoredPrMinutes: z.number().nonnegative(),
  /** Median over merged waits and censored ages together: a lower bound on the true median. */
  medianWithCensoredMin: minutes,
});

export type LatencyStats = z.infer<typeof latencyStatsSchema>;

export function latencyStats(outcomes: readonly MergeOutcome[]): LatencyStats {
  const merged = sorted(outcomes.filter((o) => o.status === "merged").map((o) => o.minutes!));
  const censored = sorted(outcomes.filter((o) => o.status === "open").map((o) => o.minutes!));
  return {
    merged: merged.length,
    medianMin: median(merged),
    meanMin: merged.length === 0 ? null : round(merged.reduce((a, b) => a + b, 0) / merged.length),
    p90Min: nearestRank(merged, 0.9),
    maxMin: merged.at(-1) === undefined ? null : round(merged.at(-1)!),
    censored: censored.length,
    oldestCensoredMin: censored.at(-1) === undefined ? null : round(censored.at(-1)!),
    censoredPrMinutes: round(censored.reduce((a, b) => a + b, 0)),
    medianWithCensoredMin: median(sorted([...merged, ...censored])),
  };
}

function sorted(values: number[]): number[] {
  return values.sort((a, b) => a - b);
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const mid = Math.floor(values.length / 2);
  return round(values.length % 2 === 1 ? values[mid]! : (values[mid - 1]! + values[mid]!) / 2);
}

function nearestRank(values: readonly number[], p: number): number | null {
  return values.length === 0 ? null : round(values[Math.ceil(p * values.length) - 1]!);
}

export function round(value: number): number {
  return Math.round(value * 10) / 10;
}
