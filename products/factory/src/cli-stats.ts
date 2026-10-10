import { fileURLToPath } from "node:url";
import type { MetricsEntryRead } from "@titan-design/health/metrics";
import { openDatabase } from "@titan-design/store-sqlite";
import { WorkflowRunStore, type WorkflowRun, type WorkflowStatus } from "@titan-design/workflow";
import type { Command } from "commander";
import type { CliIo } from "./cli.js";
import { SHEPHERD_WORKFLOW } from "./shepherd/commands.js";
import { eventsSince } from "./shepherd/events.js";
import { readAllGates } from "./shepherd/owner-friction-read.js";
import { ownerFriction, type FrictionDay } from "./shepherd/owner-friction.js";
import { reviewCauseStats, type ReviewCauseRow } from "./shepherd/review-cause.js";
import { stageStats, type StageWeek } from "./shepherd/stage-times.js";
import { overrideLines, overrideStats, type OverrideRow } from "./shepherd/override-stats.js";
import { failureStats, formatFailures } from "./shepherd/stats-failures.js";
import { shepherdStats, type StatsRow } from "./shepherd/stats.js";
import { claudeTranscripts, formatReviewCost, reviewCost } from "./shepherd/stats-cost.js";
import { formatRedAfterMerge, redAfterMerge } from "./shepherd/stats-quality.js";
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
}

/** This checkout's registry entry: the factory runs from its own checkout, and src/ and dist/ sit at the same depth. */
const SHEPHERD_REGISTRY = fileURLToPath(new URL("../../../metrics/shepherd.yml", import.meta.url));

function formatStages(weeks: readonly StageWeek[]): string[] {
  const lines = weeks.flatMap((w) => [`${w.repo}  ${w.week}`, ...w.stages.map((s) => `  ${s.stage}  runs ${s.runs}  median ${s.medianMinutes}m  p90 ${s.p90Minutes}m  max ${s.maxMinutes}m`)]);
  return lines.length === 0 ? [] : ["", "time per stage:", ...lines];
}

function formatStats(rows: readonly StatsRow[], friction: readonly FrictionDay[], stages: readonly StageWeek[], overrides: readonly OverrideRow[]): string {
  const merges = rows.length === 0 ? ["no merges in range"] : rows.map((r) => `${r.repo}  ${r.week}  merges ${r.merges}  slow(>60m) ${r.slowMerges}  slow hours ${r.slowHours}  outside Shepherd ${r.outsideMerges}`);
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

/** Reads the ledger synchronously, before the caller closes it; only the cost query awaits, and it reads transcripts. */
function sloReport(entry: MetricsEntryRead, db: ReturnType<typeof openDatabase>, opts: StatsOpts, now: number): Promise<string> {
  const runs = shepherdRuns(db);
  const base = { runs, gates: readAllGates(db), events: eventsSince(db), now, cost: (range: { from?: string; to?: string }) => reviewCost(runs, claudeTranscripts(), range) };
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
  if (opts.json) return `${JSON.stringify({ merges: rows, ownerFriction: friction, stageTimes: stages, redAfterMerge: red, ownerOverrides: overrides, ...(failures && { failures }), reviewCauses: causes }, null, 2)}\n`;
  const lines = [...formatRedAfterMerge(red), ...(failures ? formatFailures(failures) : [])].map((line) => `${line}\n`).join("");
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

/** `titan-factory shepherd stats`: reads the ledger through a read-only connection, so a running serve is never disturbed. */
export function registerShepherdStats(shepherd: Command, io: CliIo, dbPath: () => string, setExit: (code: number) => void, now: () => number = Date.now): void {
  shepherd
    .command("stats")
    .description("per repo and ISO week: PRs whose reviewer MERGE-to-merged wait exceeded 60 minutes, and merges made outside Shepherd; per day: owner touches and the hours each gate kind waited on the owner; per repo and ISO week: median, p90 and max minutes per stage (queued, ci, review, re-review, hold, land); per repo and ISO week: merged runs whose main CI went red, and those since reverted; per repo and ISO week: review dispatches counted by why each was dispatched")
    .option("--from <date>", "first day, YYYY-MM-DD (UTC)")
    .option("--to <date>", "last day, YYYY-MM-DD (UTC), inclusive")
    .option("--json", "print the rows as JSON")
    .option("--cost", "instead: reviewer dollars and tokens per merged PR, per repo and ISO week, read from the verdicts' transcripts")
    .option("--rereviews", "print only the review dispatches per repo and ISO week, counted by why each was dispatched")
    .option("--slo", "instead: each metric in metrics/shepherd.yml with its value over its SLO window (or --from/--to), its SLO, and pass or fail")
    .option("--registry <file>", "the titan.metrics/v1 entry --slo reads (default: this checkout's metrics/shepherd.yml)")
    .option("--failures", "also count failed runs per repo and ISO week by failure class (ci-timeout, gh-api-5xx, land-rules, update-branch, other)")
    .action((opts: StatsOpts) => {
      const bad = [opts.from, opts.to].find((date) => date !== undefined && !DATE.test(date));
      if (bad !== undefined) return (io.stderr(`error: expected YYYY-MM-DD, got ${JSON.stringify(bad)}\n`), setExit(2));
      let db: ReturnType<typeof openDatabase>;
      try {
        db = openDatabase(dbPath(), { readonly: true });
      } catch (error) {
        return (io.stderr(`error: cannot read the store at ${dbPath()}: ${error instanceof Error ? error.message : String(error)}\n`), setExit(2));
      }
      try {
        if (opts.slo) return sloOrExit(db, opts, now(), io, setExit);
        if (opts.cost) return costReport(shepherdRuns(db), opts).then((report) => io.stdout(report));
        io.stdout(statsReport(db, opts, now()));
      } finally {
        db.close();
      }
    });
}
