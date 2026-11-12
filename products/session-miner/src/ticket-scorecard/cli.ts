import os from "node:os";
import path from "node:path";
import { expandHome } from "@titan-design/session-read";
import type { Command } from "commander";
import type { MinerConfig } from "../config.js";
import type { ScorecardPaths } from "./load.js";
import { factoryPerRunCli } from "./per-run.js";
import { runTicketScorecard, type ScorecardRunOptions, type ScorecardRunResult } from "./run.js";

/** The S3 backfill export, kept in the initiative's sources folder where the owner can read it. */
const LABELS_FILE = path.join("titan-platform", "sources", "TP-5446-backfill", "labels-inferred-2026-11-12.jsonl");

interface RunFlags {
  rebuild?: boolean;
  dryRun?: boolean;
  store?: string;
  labels?: string;
  factoryDb?: string;
}

function dataHome(env: NodeJS.ProcessEnv): string {
  return env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share");
}

function stateHome(env: NodeJS.ProcessEnv): string {
  return env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state");
}

/** The scorecard's own store: `--store`, else `TITAN_SCORECARD_STORE`, else `~/.local/share/titan-scorecard/scorecard.sqlite3`. */
function defaultStoreFile(env: NodeJS.ProcessEnv): string {
  return expandHome(env.TITAN_SCORECARD_STORE ?? path.join(dataHome(env), "titan-scorecard", "scorecard.sqlite3"));
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
  const store = expandHome(flags.store ?? defaultStoreFile(env));
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

function renderRun(result: ScorecardRunResult): string {
  const lines = [
    `ticket-scorecard ${result.mode}: ${result.ok ? "ok" : "not measured"} in ${result.ms} ms`,
    `  not measured: ${result.notMeasured.length === 0 ? "none" : result.notMeasured.join(", ")}`,
    `  labels: ${result.labels === null ? "none" : `${result.labels.rows} rows, ${result.labels.invalid} invalid`}`,
    `  dirty tasks ${result.dirtyTasks}  task rows changed ${result.taskRowsChanged} of ${result.taskRows}  week cells changed ${result.weekRowsChanged} of ${result.weekRows}`,
    `  phase cells changed ${result.phaseRowsChanged}  pool rows written ${result.poolRowsWritten}  marks advanced ${result.marksAdvanced}`,
    `  frozen ${result.frozen.join(", ") || "none"}  drift ${result.drift.join(", ") || "none"}`,
  ];
  return `${lines.join("\n")}\n`;
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
}
