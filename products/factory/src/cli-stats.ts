import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { MetricsEntryRead } from "@titan-design/health/metrics";
import { openDatabase } from "@titan-design/store-sqlite";
import { WorkflowRunStore, type WorkflowRun, type WorkflowStatus } from "@titan-design/workflow";
import type { Command } from "commander";
import type { CliIo } from "./cli.js";
import { parseSinceOption } from "./digest/command.js";
import { gateStats, visualGateStats, type GateStatsRow, type VisualGateStats } from "./shepherd/gate-stats.js";
import { SHEPHERD_WORKFLOW } from "./shepherd/services.js";
import { eventsSince } from "./shepherd/events.js";
import { readAllGates } from "./shepherd/owner-friction-read.js";
import { ownerFriction, type FrictionDay } from "./shepherd/owner-friction.js";
import { reviewCauseStats, type ReviewCauseRow } from "./shepherd/review-cause.js";
import { formatReviewReport, reviewReport } from "./shepherd/review-stats-report.js";
import { REVIEW_STATS_DB, ReviewStatsStore } from "./shepherd/review-stats-store.js";
import { ledgerRuns, readRetireCosts, refreshReviewStats } from "./shepherd/review-stats.js";
import { stageStats, type StageWeek } from "./shepherd/stage-times.js";
import { perRunExport } from "./shepherd/per-run-export.js";
import { ShepherdStore } from "./shepherd/store.js";
import { overrideLines, overrideStats, type OverrideRow } from "./shepherd/override-stats.js";
import { failureStats, formatFailures } from "./shepherd/stats-failures.js";
import { shepherdStats, type StatsRow } from "./shepherd/stats.js";
import { claudeTranscripts, formatReviewCost, reviewCost } from "./shepherd/stats-cost.js";
import { formatRedAfterMerge, redAfterMerge } from "./shepherd/stats-quality.js";
import { shadowsIn } from "./shepherd/train-shadow.js";
import { formatTrainShadow, trainShadowStats } from "./shepherd/train-shadow-stats.js";
import { evaluateSlo, formatSlo, readRegistry } from "./shepherd/slo.js";

const ALL_STATUSES: WorkflowStatus[] = ["running", "paused", "cancelling", "recovery_required", "completed", "failed", "cancelled"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

interface StatsOpts {
  from?: string;
  to?: string;
  json?: boolean;
  cost?: boolean;
  rereviews?: boolean;
  failures?: boolean;
  slo?: boolean;
  registry?: string;
  perRun?: boolean;
  gates?: boolean;
  reviews?: boolean;
  repo?: string;
  rows?: boolean;
  /** Minutes, parsed from `90m`, `6h` or `7d`. */
  since?: number;
}

/** This checkout's registry entry: the factory runs from its own checkout, and src/ and dist/ sit at the same depth. */
const SHEPHERD_REGISTRY = fileURLToPath(new URL("../../../metrics/shepherd.yml", import.meta.url));

function formatStages(weeks: readonly StageWeek[]): string[] {
  const lines = weeks.flatMap((w) => [`${w.repo}  ${w.week}`, ...w.stages.map((s) => `  ${s.stage}  runs ${s.runs}  median ${s.medianMinutes}m  p90 ${s.p90Minutes}m  max ${s.maxMinutes}m`)]);
  return lines.length === 0 ? [] : ["", "time per stage:", ...lines];
}

function mergeLine(r: StatsRow): string {
  const ups = r.mergeUps;
  return `${r.repo}  ${r.week}  merges ${r.merges}  slow(>60m) ${r.slowMerges}  slow hours ${r.slowHours}  slow owner-gated ${r.slowOwnerGated}  outside Shepherd ${r.outsideMerges}  merge-ups land/strict/freeze/base/retry ${ups.landTime}/${ups.strictChase}/${ups.freezeHold}/${ups.baseRed}/${ups.retry}  strict rounds ${r.strictRounds}  foreign merge-ups ${r.foreignMergeUps}`;
}

function formatStats(rows: readonly StatsRow[], friction: readonly FrictionDay[], stages: readonly StageWeek[], overrides: readonly OverrideRow[]): string {
  const merges = rows.length === 0 ? ["no merges in range"] : rows.map(mergeLine);
  const days = friction.flatMap((d) => [`${d.day}  owner touches ${d.ownerTouches}`, ...d.kinds.map((k) => `  ${k.kind}  gates ${k.gates}  median ${k.medianHours}h  max ${k.maxHours}h`)]);
  return `${[...merges, ...(days.length > 0 ? ["", "owner friction:", ...days] : []), ...formatStages(stages), ...overrideLines(overrides)].join("\n")}\n`;
}

function formatCauses(rows: readonly ReviewCauseRow[]): string[] {
  return rows.flatMap((r) => [`${r.repo}  ${r.week}  reviews ${r.reviews}`, ...Object.entries(r.causes).map(([cause, count]) => `  ${cause}  ${count}`)]);
}

function causesReport(rows: readonly ReviewCauseRow[], json: boolean | undefined): string {
  if (json) return `${JSON.stringify({ reviewCauses: rows }, null, 2)}\n`;
  return `${(rows.length === 0 ? ["no reviews in range"] : formatCauses(rows)).join("\n")}\n`;
}

function shepherdRuns(db: ReturnType<typeof openDatabase>): WorkflowRun[] {
  return new WorkflowRunStore(db).listByStatus(ALL_STATUSES).filter((run) => run.workflowName === SHEPHERD_WORKFLOW);
}

async function costReport(runs: readonly WorkflowRun[], opts: StatsOpts): Promise<string> {
  const cost = await reviewCost(runs, claudeTranscripts(), opts);
  return opts.json ? `${JSON.stringify({ reviewCost: cost }, null, 2)}\n` : formatReviewCost(cost);
}

/** Kind comes from the registration; a run with none reads as `unknown`. */
function perRunReport(db: ReturnType<typeof openDatabase>, opts: StatsOpts): string {
  const kinds = new Map(new ShepherdStore(db).all().map((registration) => [registration.runId, registration.kind]));
  return `${JSON.stringify({ perRun: perRunExport(shepherdRuns(db), kinds, { from: opts.from, to: opts.to }) }, null, 2)}\n`;
}

/** The broker's seat logs, Shepherd's `logs/shepherd/` among them: AUTONOMY_ROOT, else under ACTIVE_ROOT, else active-work's default root. */
function seatLogsDir(env: NodeJS.ProcessEnv): string {
  const active = env.ACTIVE_ROOT || path.join(env.XDG_DATA_HOME || path.join(env.HOME || homedir(), ".local", "share"), "active-work");
  return path.join(env.AUTONOMY_ROOT || path.join(active, "claude-channels", "sources", "autonomy"), "logs");
}

/**
 * Refreshes `review-stats.sqlite3` beside the ledger, then reads the report from it. The ledger's runs are read before
 * the first await, so the caller may close its read-only connection as soon as this returns.
 */
async function reviewsReport(db: ReturnType<typeof openDatabase>, opts: StatsOpts, io: CliIo, dbPath: string, now: number): Promise<string> {
  const store = ReviewStatsStore.open(path.join(path.dirname(dbPath), REVIEW_STATS_DB));
  try {
    const runs = ledgerRuns(db).runs(store.refreshedThrough());
    const refresh = await refreshReviewStats({ store, runs: { runs: () => runs }, retire: readRetireCosts(seatLogsDir(io.env)), transcripts: claudeTranscripts() });
    const report = reviewReport(store.db, { from: opts.from, to: opts.to, repo: opts.repo }, now, opts.rows);
    if (opts.json) return `${JSON.stringify({ ...report, refresh }, null, 2)}\n`;
    return `${formatReviewReport(report)}refresh: ${refresh.added} new reviews, ${refresh.repriced} repriced, ${refresh.transcriptReads} transcript reads\n`;
  } finally {
    store.close();
  }
}

function gateLine(r: GateStatsRow): string {
  const decisions = Object.entries(r.decisions).map(([decision, n]) => `${decision} ${n}`).join(" ");
  return `${r.policyRow}  ${r.resolver}  gates ${r.count}  decisions ${decisions || "-"}  cancelled-unanswered ${r.cancelledUnanswered}  pending ${r.pending}  median ${r.medianHours}h  max ${r.maxHours}h`;
}

function visualLines(v: VisualGateStats): string[] {
  const hours = (h: number | null): string => (h === null ? "-" : `${h}h`);
  return [
    `visual gates  opened ${v.count}  resolved ${v.resolved}  open ${v.open}  latency median ${hours(v.medianHours)}  p90 ${hours(v.p90Hours)}`,
    `visual re-asks  total ${v.reAsks}  PRs with a re-ask ${v.prsWithReAsk}`,
  ];
}

function gatesReport(db: ReturnType<typeof openDatabase>, opts: StatsOpts, now: number): string {
  const all = readAllGates(db);
  const rows = gateStats(all, now, opts.since!);
  const visual = visualGateStats(all, now, opts.since!);
  if (opts.json) return `${JSON.stringify({ gates: rows, visual }, null, 2)}\n`;
  return `${[...(rows.length === 0 ? ["no gates in window"] : rows.map(gateLine)), ...visualLines(visual)].join("\n")}\n`;
}

/** `--since` is the meter's own window, so it pairs only with `--gates` and never with the day range. */
function usageError(opts: StatsOpts): string | undefined {
  const bad = [opts.from, opts.to].find((date) => date !== undefined && !DATE.test(date));
  if (bad !== undefined) return `expected YYYY-MM-DD, got ${JSON.stringify(bad)}`;
  if (opts.perRun && !opts.json) return "--per-run prints JSON only; add --json";
  if ((opts.repo !== undefined || opts.rows) && !opts.reviews) return "--repo and --rows apply only to --reviews";
  if (opts.rows && !opts.json) return "--rows prints JSON only; add --json";
  if (opts.gates && opts.since === undefined) return "--gates needs --since, e.g. --since 7d";
  if (opts.since !== undefined && !opts.gates) return "--since applies only to --gates";
  if (opts.gates && (opts.from !== undefined || opts.to !== undefined)) return "--gates takes --since, not --from/--to";
  return undefined;
}

function heldRunIds(db: ReturnType<typeof openDatabase>): string[] {
  return db.prepare("SELECT run_id FROM shepherd_registration WHERE held = 1 AND owner_hold_reason IS NOT NULL").pluck().all().map(String);
}

/** Reads the ledger synchronously, before the caller closes it; only the cost query awaits, and it reads transcripts. */
function sloReport(entry: MetricsEntryRead, db: ReturnType<typeof openDatabase>, opts: StatsOpts, now: number): Promise<string> {
  const runs = shepherdRuns(db);
  const cost = (range: { from?: string; to?: string }) => reviewCost(runs, claudeTranscripts(), range);
  const base = { runs, gates: readAllGates(db), events: eventsSince(db), heldRunIds: heldRunIds(db), now, cost };
  return evaluateSlo(entry, base, { from: opts.from, to: opts.to }).then((results) => (opts.json ? `${JSON.stringify({ slo: results }, null, 2)}\n` : formatSlo(results)));
}

/** The review causes are their own section, after the others, so the other sections read as before. */
function statsReport(db: ReturnType<typeof openDatabase>, opts: StatsOpts, now: number): string {
  const range = { from: opts.from, to: opts.to };
  const runs = shepherdRuns(db);
  const causes = reviewCauseStats(runs, range);
  if (opts.rereviews) return causesReport(causes, opts.json);
  const rows = shepherdStats(runs, range);
  const friction = ownerFriction(readAllGates(db), now, range);
  const stages = stageStats(runs, range);
  const red = redAfterMerge(runs, range);
  const failures = opts.failures ? failureStats(runs, range) : undefined;
  const overrides = overrideStats(runs, range);
  const train = trainShadowStats(shadowsIn(db), runs, range);
  if (opts.json) return `${JSON.stringify({ merges: rows, ownerFriction: friction, stageTimes: stages, redAfterMerge: red, ownerOverrides: overrides, trainShadow: train, ...(failures && { failures }), reviewCauses: causes }, null, 2)}\n`;
  const lines = [...formatRedAfterMerge(red), ...formatTrainShadow(train), ...(failures ? formatFailures(failures) : [])].map((line) => `${line}\n`).join("");
  return `${formatStats(rows, friction, stages, overrides)}${lines}${causes.length === 0 ? "" : `\nreview causes:\n${causesReport(causes, false)}`}`;
}

function sloOrExit(db: ReturnType<typeof openDatabase>, opts: StatsOpts, now: number, io: CliIo, setExit: (code: number) => void): Promise<void> | void {
  let entry: MetricsEntryRead;
  try {
    entry = readRegistry(opts.registry ?? SHEPHERD_REGISTRY);
  } catch (error) {
    return (io.stderr(`error: cannot read the metrics registry: ${error instanceof Error ? error.message : String(error)}\n`), setExit(2));
  }
  return sloReport(entry, db, opts, now).then((report) => io.stdout(report));
}

function statsAction(opts: StatsOpts, io: CliIo, dbPath: () => string, setExit: (code: number) => void, now: () => number): Promise<void> | void {
  const usage = usageError(opts);
  if (usage !== undefined) return (io.stderr(`error: ${usage}\n`), setExit(2));
  let db: ReturnType<typeof openDatabase>;
  try {
    db = openDatabase(dbPath(), { readonly: true });
  } catch (error) {
    return (io.stderr(`error: cannot read the store at ${dbPath()}: ${error instanceof Error ? error.message : String(error)}\n`), setExit(2));
  }
  try {
    if (opts.gates) return io.stdout(gatesReport(db, opts, now()));
    if (opts.slo) return sloOrExit(db, opts, now(), io, setExit);
    if (opts.perRun) return io.stdout(perRunReport(db, opts));
    if (opts.reviews) return reviewsReport(db, opts, io, dbPath(), now()).then((report) => io.stdout(report));
    if (opts.cost) return costReport(shepherdRuns(db), opts).then((report) => io.stdout(report));
    io.stdout(statsReport(db, opts, now()));
  } finally {
    db.close();
  }
}

/** `titan-factory shepherd stats`: reads the ledger through a read-only connection, so a running serve is never disturbed. */
export function registerShepherdStats(shepherd: Command, io: CliIo, dbPath: () => string, setExit: (code: number) => void, now: () => number = Date.now): void {
  shepherd
    .command("stats")
    .description("per repo and ISO week: PRs whose reviewer MERGE-to-merged wait exceeded 60 minutes and how many an owner approve-merge gate held, merges made outside Shepherd, Shepherd's merge-ups by class (land time, strict chase, freeze hold, base red, retry), strict land-rules rounds, and merges of the base pushed by others; per day: owner touches and the hours each gate kind waited on the owner; per repo and ISO week: median, p90 and max minutes per stage (queued, ci, review, re-review, hold, land); per repo and ISO week: merged runs whose main CI went red, and those since reverted; per repo and ISO week: review dispatches counted by why each was dispatched; with --gates --since: gates per policy row and resolver class")
    .option("--from <date>", "first day, YYYY-MM-DD (UTC)")
    .option("--to <date>", "last day, YYYY-MM-DD (UTC), inclusive")
    .option("--json", "print the rows as JSON")
    .option("--cost", "instead: reviewer dollars and tokens per merged PR, per repo and ISO week, read from the verdicts' transcripts")
    .option("--reviews", "instead: refresh review-stats.sqlite3 beside the database, then print per-review dollars, review and queue minutes (p50, p90, mean, total) by repo, ISO week, model and verdict, and per-PR rounds, dollars and review minutes")
    .option("--repo <owner/name>", "with --reviews: only this repo")
    .option("--rows", "with --reviews --json: also print every review row")
    .option("--rereviews", "print only the review dispatches per repo and ISO week, counted by why each was dispatched")
    .option("--slo", "instead: each metric in metrics/shepherd.yml with its value over its SLO window (or --from/--to), its SLO, and pass or fail")
    .option("--registry <file>", "the titan.metrics/v1 entry --slo reads (default: this checkout's metrics/shepherd.yml)")
    .option("--per-run", "instead, with --json: one record per shepherd-pr run started in range, with its stage minutes, review rounds and merge path")
    .option("--failures", "also count failed runs per repo and ISO week by failure class (ci-timeout, gh-api-5xx, land-rules, update-branch, other)")
    .option("--gates", "instead, with --since: gates opened in the window per policy row and resolver (owner-terminal, owner-remote, coordinator, delegate, unanswered), with decisions by value, cancelled-unanswered, pending, and median and max wait hours; plus visual-gate latency (median, p90) and re-asks per PR")
    .option("--since <window>", "the --gates window back from now: 90m, 6h or 7d", parseSinceOption)
    .action((opts: StatsOpts) => statsAction(opts, io, dbPath, setExit, now));
}
