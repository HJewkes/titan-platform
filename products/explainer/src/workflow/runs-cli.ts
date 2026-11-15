import type { WorkflowRun } from "@titan-design/workflow";
import { WorkflowRunStore } from "@titan-design/workflow";
import { Command, CommanderError } from "commander";
import { openState } from "./host.js";
import { STAGES, StageRecordSchema, StopSchema, type StageName, type StageRecord, type Stop } from "./records.js";
import { ownUsd, stageRecords } from "./report.js";
import { readJson, runPaths } from "./run-dir.js";
import { dataDirOption, hostFor } from "./run-cli.js";
import { planOf, videoIdOf, videoRuns } from "./video-runs.js";

const EXIT = { OK: 0, USAGE: 2 } as const;

interface RunsCliDeps {
  out?: (text: string) => void;
  err?: (text: string) => void;
  now?: () => Date;
}

interface RunRow {
  runId: string;
  videoId: string;
  status: string;
  from: StageName;
  to: StageName;
  usd: number;
  wallS: number;
  costUnknown: boolean;
  /** Every stage the run ran has a record, none unpriced or bridged. */
  fullRecords: boolean;
  failedStage?: StageName;
  stop?: Stop;
}

interface RunsListing {
  runs: RunRow[];
  fullRecords: number;
  total: number;
}

/** The stage records a run holds, a failed stage's included, as `ownUsd` counts them. */
function recordsOf(dataDir: string, run: WorkflowRun): { records: StageRecord[]; failed?: StageRecord } {
  const paths = runPaths(dataDir, run.id);
  const failed = STAGES.map((stage) => readJson(paths.failed(stage), StageRecordSchema)).find((r) => r !== undefined);
  return { records: [...stageRecords(run), ...(failed ? [failed] : [])], ...(failed ? { failed } : {}) };
}

/** The stages the run got to: through `to` when it finished, up to the failed or stopped stage when it did not. */
function stagesRan(from: StageName, to: StageName, status: string, failed: StageRecord | undefined, stop: Stop | undefined): StageName[] {
  const first = STAGES.indexOf(from);
  if (status === "completed") return STAGES.slice(first, STAGES.indexOf(to) + 1);
  if (failed) return STAGES.slice(first, STAGES.indexOf(failed.stage) + 1);
  if (stop) return STAGES.slice(first, STAGES.indexOf(stop.stage));
  return STAGES.slice(first, STAGES.indexOf(to) + 1);
}

function rowOf(dataDir: string, runs: WorkflowRunStore, run: WorkflowRun, now: Date): RunRow {
  const plan = planOf(run);
  const { records, failed } = recordsOf(dataDir, run);
  const stop = readJson(runPaths(dataDir, run.id).stop, StopSchema);
  const priced = records.every((r) => r.usage.costUnknown !== true && !r.bridged);
  const have = new Set(records.map((r) => r.stage));
  const complete = run.status === "completed" || failed !== undefined || stop !== undefined;
  const fullRecords = complete && priced && stagesRan(plan.from, plan.to, run.status, failed, stop).every((stage) => have.has(stage));
  const end = run.completedAt ? Date.parse(run.completedAt) : now.getTime();
  return {
    runId: run.id, videoId: videoIdOf(runs, run), status: run.status, from: plan.from, to: plan.to, usd: ownUsd(records),
    wallS: (end - Date.parse(run.startedAt)) / 1000, costUnknown: records.some((r) => r.usage.costUnknown === true), fullRecords,
    ...(failed ? { failedStage: failed.stage } : {}), ...(stop ? { stop } : {}),
  };
}

/** Every explainer-video run, newest first. Reads the state database and the run directories; writes nothing into a run. */
function listRuns(dataDir: string, filter: { video?: string }, now: Date): RunsListing {
  const db = openState(dataDir);
  try {
    const store = new WorkflowRunStore(db);
    const all = videoRuns(store).sort((a, b) => b.startedAt.localeCompare(a.startedAt)).map((run) => rowOf(dataDir, store, run, now));
    const rows = filter.video ? all.filter((row) => row.videoId === filter.video) : all;
    return { runs: rows, fullRecords: rows.filter((row) => row.fullRecords).length, total: rows.length };
  } finally {
    db.close();
  }
}

function lineOf(row: RunRow): string {
  const why = row.failedStage ? `failed at ${row.failedStage}` : row.stop ? `cap stop before ${row.stop.stage}` : "";
  const cells = [row.runId, row.videoId, row.status, `${row.from}..${row.to}`, `$${row.usd.toFixed(4)}${row.costUnknown ? "+" : ""}`, `${row.wallS.toFixed(1)} s`, why];
  return cells.filter((cell) => cell !== "").join("  ");
}

const renderRuns = (listing: RunsListing): string =>
  `${[...listing.runs.map(lineOf), `${listing.fullRecords} of ${listing.total} runs have per-stage cost and runtime`].join("\n")}\n`;

/** `explainer runs [--video <id>] [--json] [--data-dir <dir>]`: one line per run, newest first. */
export async function runRunsCli(argv: readonly string[], deps: RunsCliDeps = {}): Promise<number> {
  const out = deps.out ?? ((text: string) => process.stdout.write(text));
  const err = deps.err ?? ((text: string) => process.stderr.write(text));
  const program = new Command("explainer").exitOverride().configureOutput({ writeOut: out, writeErr: err });
  program.addCommand(new Command("runs")
    .description("List explainer-video runs, newest first: each run's own cost and wall time, and how many have per-stage records")
    .addOption(dataDirOption())
    .option("--video <id>", "only the runs of this video")
    .option("--json", "print the listing as JSON")
    .exitOverride()
    .action((flags: { dataDir?: string; video?: string; json?: boolean }) => {
      const listing = listRuns(hostFor(flags, {}).dataDir, flags.video ? { video: flags.video } : {}, (deps.now ?? (() => new Date()))());
      out(flags.json ? `${JSON.stringify(listing, null, 2)}\n` : renderRuns(listing));
    }));
  try {
    await program.parseAsync([...argv], { from: "user" });
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode === 0 ? EXIT.OK : EXIT.USAGE;
    err(`runs: ${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT.USAGE;
  }
  return EXIT.OK;
}
