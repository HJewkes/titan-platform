import type { WorkflowRun } from "@titan-design/workflow";
import { holdClassOf } from "./g10-release.js";
import { checkHoldReason } from "./hold-reason.js";
import { mergedAt } from "./stats.js";

/** One `merged` row of a seat's `dispatch.jsonl`, its time read as an instant. */
export interface MergedRow {
  seat: string;
  at: number;
  /** As the seat wrote it: `owner/repo#n`, a bare number, a numeric string, or anything else. */
  pr: unknown;
  gate?: string;
  note: string;
}

/** The part of a Shepherd registration the fold reads; `Registration` from the store satisfies it. */
export interface LedgerRegistration {
  repo: string;
  pr: number | null;
  runId: string;
  policy: { merge: string };
  held: boolean;
  holdReason: string | null;
  createdAt: string;
}

/** Half-open, epoch milliseconds: `start <= at < end`. */
export interface CoverageWindow {
  start: number;
  end: number;
}

export interface CoverageInput {
  rows: readonly MergedRow[];
  /** Lines already skipped while reading the logs. */
  skipped: number;
  registrations: readonly LedgerRegistration[];
  runs: readonly WorkflowRun[];
  /** Seat name to the `owner/name` remotes it owns; a bare PR number resolves only among its seat's remotes. */
  remotes: Readonly<Record<string, readonly string[]>>;
  window: CoverageWindow;
}

/** `merged` is the denominator: unique PRs merged in the window less the `excluded` ones; `share` is undefined when it is 0. */
interface CoverageCounts {
  merged: number;
  excluded: number;
  shepherd: number;
  share: number | undefined;
}

interface SeatCoverage extends CoverageCounts {
  seat: string;
}

/** A counted merge no completed Shepherd run landed; `unresolved` when the row's PR could not be tied to one repo. */
interface CoverageMiss {
  seat: string;
  pr: string;
  note: string;
  holdReason: string | null;
  unresolved: boolean;
}

interface UntypedHold {
  runId: string;
  repo: string;
  pr: number | null;
  reason: string;
  servePath: boolean;
  seatPath: boolean;
}

export interface CoverageReport {
  window: CoverageWindow;
  seats: SeatCoverage[];
  total: CoverageCounts;
  misses: CoverageMiss[];
  untypedHolds: UntypedHold[];
  skipped: number;
}

/** Charter 8 "Exclusions": owner-gated visual and benchmark merges are not Shepherd's to make. */
const EXCLUDED_GATES: ReadonlySet<string> = new Set(["visual", "bench"]);
const SERVE_PATH = /serve|7410|service not loaded/i;
const SEAT_PATH = /interim|seat path|seat-merge|bin\/merge|per seat file/i;
const QUALIFIED_PR = /^([\w.-]+\/[\w.-]+)#(\d+)$/;
const HAS_ZONE = /(?:Z|[+-]\d{2}:?\d{2})$/i;

/** A time with no zone is read as UTC, as the seats' hand counts read it. */
function instantOf(ts: unknown): number | undefined {
  if (typeof ts !== "string") return undefined;
  const at = Date.parse(HAS_ZONE.test(ts) ? ts : `${ts}Z`);
  return Number.isNaN(at) ? undefined : at;
}

function parseLine(line: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** The `merged` rows of one seat's `dispatch.jsonl`; a line that is not JSON, or a merged row with no readable time, is skipped and counted. */
export function mergedRows(seat: string, jsonl: string): { rows: MergedRow[]; skipped: number } {
  const rows: MergedRow[] = [];
  let skipped = 0;
  for (const line of jsonl.split("\n").filter((l) => l.trim() !== "")) {
    const value = parseLine(line);
    if (value !== undefined && value.outcome !== "merged") continue;
    const at = instantOf(value?.ts);
    if (value === undefined || at === undefined) {
      skipped++;
      continue;
    }
    const gate = typeof value.gate === "string" ? value.gate : undefined;
    rows.push({ seat, at, pr: value.pr, gate, note: typeof value.note === "string" ? value.note : "" });
  }
  return { rows, skipped };
}

interface Ledger {
  byPr: Map<string, LedgerRegistration[]>;
  runs: Map<string, WorkflowRun>;
}

const prKey = (repo: string, pr: number): string => `${repo.toLowerCase()}#${pr}`;

function indexLedger(input: CoverageInput): Ledger {
  const byPr = new Map<string, LedgerRegistration[]>();
  for (const registration of input.registrations) {
    if (registration.pr === null) continue;
    const key = prKey(registration.repo, registration.pr);
    byPr.set(key, [...(byPr.get(key) ?? []), registration]);
  }
  return { byPr, runs: new Map(input.runs.map((run) => [run.id, run])) };
}

interface Resolved {
  key: string;
  unresolved: boolean;
}

/** A bare number names a PR only when exactly one of the seat's remotes has a registration for it. */
function resolvePr(row: MergedRow, ledger: Ledger, remotes: readonly string[]): Resolved {
  const unresolved: Resolved = { key: String(row.pr), unresolved: true };
  const qualified = typeof row.pr === "string" ? QUALIFIED_PR.exec(row.pr) : null;
  if (qualified) return { key: prKey(qualified[1]!, Number(qualified[2])), unresolved: false };
  const bare = typeof row.pr === "number" ? row.pr : typeof row.pr === "string" && /^\d+$/.test(row.pr) ? Number(row.pr) : undefined;
  if (bare === undefined || !Number.isInteger(bare)) return unresolved;
  const keys = remotes.map((remote) => prKey(remote, bare)).filter((key) => ledger.byPr.has(key));
  return keys.length === 1 ? { key: keys[0]!, unresolved: false } : unresolved;
}

type Verdict = "excluded" | "shepherd" | "miss";

interface Judged {
  row: MergedRow;
  pr: string;
  unresolved: boolean;
  verdict: Verdict;
  registrations: readonly LedgerRegistration[];
}

const isVisualGated = (r: LedgerRegistration): boolean => r.policy.merge === "owner-gate" && holdClassOf(r.holdReason) === "visual-gate2";

function verdictOf(row: MergedRow, registrations: readonly LedgerRegistration[], ledger: Ledger): Verdict {
  if ((row.gate !== undefined && EXCLUDED_GATES.has(row.gate)) || registrations.some(isVisualGated)) return "excluded";
  const merged = registrations.some((r) => {
    const run = ledger.runs.get(r.runId);
    return run?.status === "completed" && mergedAt(run) !== undefined;
  });
  return merged ? "shepherd" : "miss";
}

/** Each PR once, judged by its first merged row in the window; later rows for it (a "main green; closed" follow-up) collapse. */
function judgeRows(input: CoverageInput, ledger: Ledger): Judged[] {
  const seen = new Map<string, Judged>();
  const inWindow = input.rows.filter((row) => row.at >= input.window.start && row.at < input.window.end);
  for (const row of [...inWindow].sort((a, b) => a.at - b.at)) {
    const resolved = resolvePr(row, ledger, input.remotes[row.seat] ?? []);
    const key = resolved.unresolved ? `${row.seat} ${resolved.key}` : resolved.key;
    if (seen.has(key)) continue;
    const registrations = resolved.unresolved ? [] : (ledger.byPr.get(resolved.key) ?? []);
    seen.set(key, { row, pr: resolved.key, unresolved: resolved.unresolved, verdict: verdictOf(row, registrations, ledger), registrations });
  }
  return [...seen.values()];
}

function countOf(judged: readonly Judged[]): CoverageCounts {
  const excluded = judged.filter((j) => j.verdict === "excluded").length;
  const shepherd = judged.filter((j) => j.verdict === "shepherd").length;
  const merged = judged.length - excluded;
  return { merged, excluded, shepherd, share: merged === 0 ? undefined : shepherd / merged };
}

const missOf = (j: Judged): CoverageMiss => ({ seat: j.row.seat, pr: j.pr, note: j.row.note, holdReason: j.registrations.at(-1)?.holdReason ?? null, unresolved: j.unresolved });

function activeIn(registration: LedgerRegistration, run: WorkflowRun | undefined, window: CoverageWindow): boolean {
  const started = Date.parse(run?.startedAt ?? registration.createdAt);
  const completed = run?.completedAt ? Date.parse(run.completedAt) : undefined;
  return started < window.end && (completed === undefined || completed >= window.start);
}

/** Held registrations, active in the window, whose reason is not a charter 8 hold reason. */
function untypedHolds(input: CoverageInput, ledger: Ledger): UntypedHold[] {
  return input.registrations
    .filter((r) => r.held && r.holdReason !== null && !checkHoldReason(r.holdReason).ok && activeIn(r, ledger.runs.get(r.runId), input.window))
    .map((r) => ({ runId: r.runId, repo: r.repo, pr: r.pr, reason: r.holdReason!, servePath: SERVE_PATH.test(r.holdReason!), seatPath: SEAT_PATH.test(r.holdReason!) }));
}

/** Per seat and in total: how many of the seats' merged PRs in the window a completed Shepherd run merged. */
export function coverage(input: CoverageInput): CoverageReport {
  const ledger = indexLedger(input);
  const judged = judgeRows(input, ledger);
  const seatNames = [...new Set([...Object.keys(input.remotes), ...judged.map((j) => j.row.seat)])];
  return {
    window: input.window,
    seats: seatNames.map((seat) => ({ seat, ...countOf(judged.filter((j) => j.row.seat === seat)) })),
    total: countOf(judged),
    misses: judged.filter((j) => j.verdict === "miss").map(missOf),
    untypedHolds: untypedHolds(input, ledger),
    skipped: input.skipped,
  };
}
