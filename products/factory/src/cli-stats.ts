import { openDatabase } from "@titan-design/store-sqlite";
import { WorkflowRunStore, type WorkflowRun, type WorkflowStatus } from "@titan-design/workflow";
import type { Command } from "commander";
import type { CliIo } from "./cli.js";
import { SHEPHERD_WORKFLOW } from "./shepherd/commands.js";
import { readAllGates } from "./shepherd/owner-friction-read.js";
import { ownerFriction, type FrictionDay } from "./shepherd/owner-friction.js";
import { stageStats, type StageWeek } from "./shepherd/stage-times.js";
import { failureStats, formatFailures } from "./shepherd/stats-failures.js";
import { shepherdStats, type StatsRow } from "./shepherd/stats.js";
import { claudeTranscripts, formatReviewCost, reviewCost } from "./shepherd/stats-cost.js";
import { formatRedAfterMerge, redAfterMerge } from "./shepherd/stats-quality.js";

const ALL_STATUSES: WorkflowStatus[] = ["running", "paused", "cancelling", "recovery_required", "completed", "failed", "cancelled"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

interface StatsOpts {
  from?: string;
  to?: string;
  json?: boolean;
  cost?: boolean;
  failures?: boolean;
}

function formatStages(weeks: readonly StageWeek[]): string[] {
  const lines = weeks.flatMap((w) => [`${w.repo}  ${w.week}`, ...w.stages.map((s) => `  ${s.stage}  runs ${s.runs}  median ${s.medianMinutes}m  p90 ${s.p90Minutes}m  max ${s.maxMinutes}m`)]);
  return lines.length === 0 ? [] : ["", "time per stage:", ...lines];
}

function formatStats(rows: readonly StatsRow[], friction: readonly FrictionDay[], stages: readonly StageWeek[]): string {
  const merges = rows.length === 0 ? ["no merges in range"] : rows.map((r) => `${r.repo}  ${r.week}  merges ${r.merges}  slow(>60m) ${r.slowMerges}  slow hours ${r.slowHours}  outside Shepherd ${r.outsideMerges}`);
  const days = friction.flatMap((d) => [`${d.day}  owner touches ${d.ownerTouches}`, ...d.kinds.map((k) => `  ${k.kind}  gates ${k.gates}  median ${k.medianHours}h  max ${k.maxHours}h`)]);
  return `${[...merges, ...(days.length > 0 ? ["", "owner friction:", ...days] : []), ...formatStages(stages)].join("\n")}\n`;
}

function shepherdReport(runs: readonly WorkflowRun[], gates: ReturnType<typeof readAllGates>, nowMs: number, opts: StatsOpts): string {
  const range = { from: opts.from, to: opts.to };
  const rows = shepherdStats(runs, range);
  const friction = ownerFriction(gates, nowMs, range);
  const stages = stageStats(runs, range);
  const failures = opts.failures ? failureStats(runs, range) : undefined;
  const red = redAfterMerge(runs, range);
  if (opts.json) return `${JSON.stringify({ merges: rows, ownerFriction: friction, stageTimes: stages, redAfterMerge: red, ...(failures && { failures }) }, null, 2)}\n`;
  return [formatStats(rows, friction, stages), ...formatRedAfterMerge(red).map((line) => `${line}\n`), ...(failures ? formatFailures(failures).map((line) => `${line}\n`) : [])].join("");
}

/** `titan-factory shepherd stats`: reads the ledger through a read-only connection, so a running serve is never disturbed. */
export function registerShepherdStats(shepherd: Command, io: CliIo, dbPath: () => string, setExit: (code: number) => void, now: () => number = Date.now): void {
  shepherd
    .command("stats")
    .description("per repo and ISO week: PRs whose reviewer MERGE-to-merged wait exceeded 60 minutes, and merges made outside Shepherd; per day: owner touches and the hours each gate kind waited on the owner; per repo and ISO week: median, p90 and max minutes per stage (queued, ci, review, re-review, hold, land); per repo and ISO week: merged runs whose main CI went red, and those since reverted")
    .option("--from <date>", "first day, YYYY-MM-DD (UTC)")
    .option("--to <date>", "last day, YYYY-MM-DD (UTC), inclusive")
    .option("--json", "print the rows as JSON")
    .option("--cost", "instead: reviewer dollars and tokens per merged PR, per repo and ISO week, read from the verdicts' transcripts")
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
        const runs = new WorkflowRunStore(db).listByStatus(ALL_STATUSES).filter((run) => run.workflowName === SHEPHERD_WORKFLOW);
        if (opts.cost) return reviewCost(runs, claudeTranscripts(), opts).then((cost) => io.stdout(opts.json ? `${JSON.stringify({ reviewCost: cost }, null, 2)}\n` : formatReviewCost(cost)));
        io.stdout(shepherdReport(runs, readAllGates(db), now(), opts));
      } finally {
        db.close();
      }
    });
}
