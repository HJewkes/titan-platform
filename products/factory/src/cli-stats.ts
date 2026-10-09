import { openDatabase } from "@titan-design/store-sqlite";
import { WorkflowRunStore, type WorkflowStatus } from "@titan-design/workflow";
import type { Command } from "commander";
import type { CliIo } from "./cli.js";
import { SHEPHERD_WORKFLOW } from "./shepherd/commands.js";
import { readAllGates } from "./shepherd/owner-friction-read.js";
import { ownerFriction, type FrictionDay } from "./shepherd/owner-friction.js";
import { stageStats, type StageWeek } from "./shepherd/stage-times.js";
import { overrideLines, overrideStats, type OverrideRow } from "./shepherd/override-stats.js";
import { failureStats, formatFailures } from "./shepherd/stats-failures.js";
import { shepherdStats, type StatsRow } from "./shepherd/stats.js";
import { formatRedAfterMerge, redAfterMerge } from "./shepherd/stats-quality.js";

const ALL_STATUSES: WorkflowStatus[] = ["running", "paused", "cancelling", "recovery_required", "completed", "failed", "cancelled"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

interface StatsOpts {
  from?: string;
  to?: string;
  json?: boolean;
  failures?: boolean;
}

function formatStages(weeks: readonly StageWeek[]): string[] {
  const lines = weeks.flatMap((w) => [`${w.repo}  ${w.week}`, ...w.stages.map((s) => `  ${s.stage}  runs ${s.runs}  median ${s.medianMinutes}m  p90 ${s.p90Minutes}m  max ${s.maxMinutes}m`)]);
  return lines.length === 0 ? [] : ["", "time per stage:", ...lines];
}

function formatStats(rows: readonly StatsRow[], friction: readonly FrictionDay[], stages: readonly StageWeek[], overrides: readonly OverrideRow[]): string {
  const merges = rows.length === 0 ? ["no merges in range"] : rows.map((r) => `${r.repo}  ${r.week}  merges ${r.merges}  slow(>60m) ${r.slowMerges}  slow hours ${r.slowHours}  outside Shepherd ${r.outsideMerges}`);
  const days = friction.flatMap((d) => [`${d.day}  owner touches ${d.ownerTouches}`, ...d.kinds.map((k) => `  ${k.kind}  gates ${k.gates}  median ${k.medianHours}h  max ${k.maxHours}h`)]);
  return `${[...merges, ...(days.length > 0 ? ["", "owner friction:", ...days] : []), ...formatStages(stages), ...overrideLines(overrides)].join("\n")}\n`;
}

interface Report {
  rows: StatsRow[];
  friction: FrictionDay[];
  stages: StageWeek[];
  red: ReturnType<typeof redAfterMerge>;
  failures: ReturnType<typeof failureStats> | undefined;
  overrides: OverrideRow[];
}

function render(opts: StatsOpts, { rows, friction, stages, red, failures, overrides }: Report): string {
  if (opts.json) return `${JSON.stringify({ merges: rows, ownerFriction: friction, stageTimes: stages, redAfterMerge: red, ownerOverrides: overrides, ...(failures && { failures }) }, null, 2)}\n`;
  return [formatStats(rows, friction, stages, overrides), ...formatRedAfterMerge(red).map((line) => `${line}\n`), ...(failures ? formatFailures(failures).map((line) => `${line}\n`) : [])].join("");
}

/** `titan-factory shepherd stats`: reads the ledger through a read-only connection, so a running serve is never disturbed. */
export function registerShepherdStats(shepherd: Command, io: CliIo, dbPath: () => string, setExit: (code: number) => void, now: () => number = Date.now): void {
  shepherd
    .command("stats")
    .description("per repo and ISO week: PRs whose reviewer MERGE-to-merged wait exceeded 60 minutes, and merges made outside Shepherd; per day: owner touches and the hours each gate kind waited on the owner; per repo and ISO week: median, p90 and max minutes per stage (queued, ci, review, re-review, hold, land); per repo and ISO week: merged runs whose main CI went red, and those since reverted")
    .option("--from <date>", "first day, YYYY-MM-DD (UTC)")
    .option("--to <date>", "last day, YYYY-MM-DD (UTC), inclusive")
    .option("--json", "print the rows as JSON")
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
        const rows = shepherdStats(runs, { from: opts.from, to: opts.to });
        const friction = ownerFriction(readAllGates(db), now(), { from: opts.from, to: opts.to });
        const stages = stageStats(runs, { from: opts.from, to: opts.to });
        const failures = opts.failures ? failureStats(runs, { from: opts.from, to: opts.to }) : undefined;
        const red = redAfterMerge(runs, { from: opts.from, to: opts.to });
        io.stdout(render(opts, { rows, friction, stages, red, failures, overrides: overrideStats(runs, { from: opts.from, to: opts.to }) }));
      } finally {
        db.close();
      }
    });
}
