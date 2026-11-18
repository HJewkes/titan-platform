import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { scorecardStorePath } from "@titan-design/app-paths";
import { expandHome } from "@titan-design/session-read";
import type { Command } from "commander";
import type { MinerConfig } from "../config.js";
import type { ScorecardPaths } from "./load.js";
import { factoryHealthLines } from "./health-text.js";
import type { OriginLinkCounts } from "./read-origin.js";
import { factoryPerRunCli } from "./per-run.js";
import { rawClassOf, readSample, rebuiltRows, renderReport, reproduce } from "./reproduce.js";
import { e1ExpectedFile, parseExpected, type ExpectedFile } from "./reproduce-spec.js";
import { EXIT_NOT_MEASURED, runTicketScorecard, type ScorecardRunOptions, type ScorecardRunResult } from "./run.js";

/** The S3 backfill export, kept in the initiative's sources folder where the owner can read it. */
const LABELS_FILE = path.join("titan-platform", "sources", "TP-5446-backfill", "labels-inferred-2026-11-12.jsonl");

interface RunFlags {
  rebuild?: boolean;
  dryRun?: boolean;
  store?: string;
  labels?: string;
  factoryDb?: string;
}

function stateHome(env: NodeJS.ProcessEnv): string {
  return env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state");
}

function scorecardPaths(config: MinerConfig, flags: RunFlags, env: NodeJS.ProcessEnv): ScorecardPaths {
  const factoryDb = flags.factoryDb ?? env.TITAN_FACTORY_DB ?? path.join(stateHome(env), "titan-factory", "factory.sqlite3");
  const labelsFile = flags.labels ?? env.TITAN_SCORECARD_LABELS ?? path.join(config.initiativesRoot, LABELS_FILE);
  return {
    eventsDb: config.eventsDb,
    factoryDb: expandHome(factoryDb),
    graphDb: config.dbPath,
    initiativesRoot: config.initiativesRoot,
    initiatives: config.throughputInitiatives,
    labelsFile: expandHome(labelsFile),
  };
}

function runOptions(config: MinerConfig, flags: RunFlags, env: NodeJS.ProcessEnv): ScorecardRunOptions {
  const store = expandHome(flags.store ?? scorecardStorePath({ env }));
  const dryRun = flags.dryRun === true;
  return {
    paths: scorecardPaths(config, flags, env),
    storeFile: dryRun ? ":memory:" : store,
    weeksDir: dryRun ? null : path.join(path.dirname(store), "weeks"),
    lockFile: dryRun ? null : path.join(path.dirname(store), "ticket-scorecard.lock"),
    rebuild: flags.rebuild === true || dryRun,
    now: () => new Date(),
    perRun: factoryPerRunCli,
  };
}

function originLinksText(counts: OriginLinkCounts | null): string {
  if (counts === null) return "not measured";
  return `${counts.linked} linked (inferred), unlinked: ${counts.several} several tasks, ${counts.none} no task, ${counts.noOrigin} no origin`;
}

function renderRun(result: ScorecardRunResult): string {
  const lines = [
    `ticket-scorecard ${result.mode}: ${result.ok ? "ok" : "not measured"} in ${result.ms} ms`,
    `  not measured: ${result.notMeasured.length === 0 ? "none" : result.notMeasured.join(", ")}`,
    `  labels: ${result.labels === null ? "none" : `${result.labels.rows} rows, ${result.labels.invalid} invalid`}`,
    `  dirty tasks ${result.dirtyTasks}  task rows changed ${result.taskRowsChanged} of ${result.taskRows}  week cells changed ${result.weekRowsChanged} of ${result.weekRows}`,
    `  spawns without meta.task: ${originLinksText(result.originLinks)}`,
    `  phase cells changed ${result.phaseRowsChanged}  factory health weeks changed ${result.healthRowsChanged}  pool rows written ${result.poolRowsWritten}  marks advanced ${result.marksAdvanced}`,
    `  frozen ${result.frozen.join(", ") || "none"}  drift ${result.drift.join(", ") || "none"}`,
    ...result.factoryHealth.flatMap(factoryHealthLines),
  ];
  return `${lines.join("\n")}\n`;
}

/** Some figure is outside its tolerance or not measured yet. */
const EXIT_MISS = 1;

interface ReproduceFlags extends RunFlags {
  population: string;
  expected?: string;
  sample?: string;
  from?: string;
  to?: string;
}

/** The expected figures, with the window narrowed or widened by `--from` and `--to`. */
function expectedOf(flags: ReproduceFlags): ExpectedFile {
  const spec = flags.expected === undefined ? e1ExpectedFile() : parseExpected(JSON.parse(readFileSync(expandHome(flags.expected), "utf8")));
  const iso = (t: string) => new Date(t).toISOString();
  return { ...spec, window: { from: flags.from === undefined ? spec.window.from : iso(flags.from), to: flags.to === undefined ? spec.window.to : iso(flags.to) } };
}

type Io = { stdout: (t: string) => void; stderr: (t: string) => void; env?: NodeJS.ProcessEnv };

/** `ticket-scorecard run`: the scheduled job. Every store but the scorecard's own opens read-only. */
export function attachTicketScorecard(program: Command, config: () => MinerConfig, io: Io, onExit: (code: number) => void): void {
  const group = program.command("ticket-scorecard").description("the per-task scorecard over agent-chat, Shepherd, the graph and the task files");
  group
    .command("run")
    .description("recompute changed task rows and weekly cells, snapshot the week's pool, freeze closed weeks")
    .option("--rebuild", "drop the derived rows and recompute every task from the raw stores")
    .option("--dry-run", "rebuild into an in-memory store and print the counts; writes nothing")
    .option("--store <file>", "the scorecard store (TITAN_SCORECARD_STORE, default ~/.local/share/titan-scorecard/scorecard.sqlite3)")
    .option("--labels <file>", "the inferred-labels JSONL (TITAN_SCORECARD_LABELS)")
    .option("--factory-db <file>", "factory's database, read-only (TITAN_FACTORY_DB)")
    .action(async (flags: RunFlags) => {
      const env = io.env ?? process.env;
      const result = await runTicketScorecard(runOptions(config(), flags, env));
      if ("locked" in result) io.stderr("ticket-scorecard: another run holds the lock; exiting\n");
      else io.stdout(program.opts().json === true ? `${JSON.stringify(result)}\n` : renderRun(result));
      onExit(result.exitCode);
    });
  attachReproduce(program, group, config, io, onExit);
}

/** `ticket-scorecard reproduce`: rebuild the rows in memory and check them against the hand audit's frozen figures. */
function attachReproduce(program: Command, group: Command, config: () => MinerConfig, io: Io, onExit: (code: number) => void): void {
  group
    .command("reproduce")
    .description("rebuild the rows in memory and print a pass/miss table against the 2026-11-12 hand audit (E1); writes nothing")
    .option("--population <name>", "the dispatcher set the figures cover", "coordinator-seats")
    .option("--from <time>", "window start, inclusive (default: the expected file's)")
    .option("--to <time>", "window end, exclusive (default: the expected file's)")
    .option("--expected <file>", "expected figures JSON (default: the bundled e1-expected.json)")
    .option("--sample <file>", "the hand audit's sample JSONL; checks every sampled task is in the population")
    .option("--labels <file>", "the inferred-labels JSONL (TITAN_SCORECARD_LABELS)")
    .option("--factory-db <file>", "factory's database, read-only (TITAN_FACTORY_DB)")
    .action(async (flags: ReproduceFlags) => {
      const env = io.env ?? process.env;
      const options = runOptions(config(), { ...flags, dryRun: true }, env);
      const rebuilt = await rebuiltRows(options);
      if (rebuilt === null) {
        io.stderr("ticket-scorecard reproduce: a store the rows need is missing; run `ticket-scorecard run --dry-run` to see which\n");
        return onExit(EXIT_NOT_MEASURED);
      }
      const input = { rows: rebuilt.rows, rawClass: rawClassOf(options.paths.labelsFile), sample: flags.sample === undefined ? null : readSample(expandHome(flags.sample)) };
      const report = reproduce(input, expectedOf(flags), flags.population, rebuilt.originLinks);
      io.stdout(program.opts().json === true ? `${JSON.stringify(report)}\n` : renderReport(report));
      onExit(report.ok ? 0 : EXIT_MISS);
    });
}
