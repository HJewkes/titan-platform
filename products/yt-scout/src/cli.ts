import { readFileSync } from "node:fs";
import path from "node:path";
import { Command, CommanderError } from "commander";
import { addEvalCommands } from "./eval-cli.js";
import { isOnTrial, type Watchlist } from "./config.js";
import { claudeScoreRunner } from "./claude-runner.js";
import { casesDir, configPath, dbPath, rowsDir, ytRoot } from "./paths.js";
import { scoreVideo, type ScoreDeps } from "./score.js";
import type { ScoreRunner } from "./seams.js";
import { formatSeenImport, importSeen } from "./seen-import.js";
import { openScoutDb } from "./store.js";
import { loadWatchlist, WatchlistError } from "./watchlist.js";

type Write = (line: string) => void;

/** Exit code for a watch list that fails to parse or validate. */
export const EXIT_CONFIG = 1;

export function describeWatchlist(w: Watchlist, today: string): string {
  const trial = w.sources.filter((s) => isOnTrial(s, today));
  const expired = w.sources.filter((s) => s.trial_until !== undefined && !isOnTrial(s, today));
  const parts = [`${w.sources.length} sources`, `${trial.length} on trial`];
  if (expired.length > 0) parts.push(`trial ended: ${expired.map((s) => s.key).join(", ")}`);
  return `ok: ${parts.join(", ")}`;
}

function addConfigCommand(program: Command, write: Write): void {
  program
    .command("config")
    .description("Watch-list commands")
    .command("check")
    .description("Validate the watch list and report its sources")
    .option("--config <file>", "watch list (default: $TITAN_YT_SCOUT_CONFIG, else the youtube initiative's scout/watchlist.yml)")
    .action((opts: { config?: string }) => {
      const watchlist = loadWatchlist(opts.config ?? configPath());
      write(describeWatchlist(watchlist, new Date().toISOString().slice(0, 10)));
    });
}

function addSeenCommand(program: Command, write: Write): void {
  program
    .command("seen")
    .description("Seen-set commands")
    .command("import")
    .description("Load the pre-scout inventory, scores, watch-later and transcripts into the videos table")
    .option("--config <file>", "watch list, used to map channels to source keys")
    .option("--root <dir>", "youtube sources tree (default: $YT_ROOT, else the youtube initiative's sources)")
    .option("--db <file>", "scout database (default: $TITAN_YT_SCOUT_DB, else ~/.local/state/titan-yt-scout/scout.sqlite3)")
    .action((opts: { config?: string; root?: string; db?: string }) => {
      const watchlist = loadWatchlist(opts.config ?? configPath());
      const db = openScoutDb(opts.db ?? dbPath());
      try {
        for (const line of formatSeenImport(importSeen(db, opts.root ?? ytRoot(), watchlist))) write(line);
      } finally {
        db.close();
      }
    });
}

function addScoreCommand(program: Command, write: Write, runner: ScoreRunner): void {
  program
    .command("score <id>")
    .description("Score one transcript with a single headless call and append its step row")
    .requiredOption("--transcript <file>", "transcript markdown, with [mm:ss] anchors")
    .requiredOption("--rubric <file>", "RUBRIC.md; only its owner's-system and scores sections are used")
    .option("--title <text>", "video title (default: the transcript's front matter)")
    .option("--out <file>", "card path (default: <id>.score.json beside the transcript)")
    .option("--source <key>", "watch-list source key")
    .option("--duration <seconds>", "video length; past 2 h only the start is scored", Number)
    .option("--workflow-version <sha>", "recorded on the row", "dev")
    .action(async (id: string, o: ScoreOptions) => {
      await runScore(id, o, write, runner);
    });
}

async function runScore(id: string, o: ScoreOptions, write: Write, runner: ScoreRunner): Promise<void> {
  const config = loadWatchlist(configPath());
  const transcriptPath = path.resolve(o.transcript);
  const deps: ScoreDeps = {
    runner,
    rubric: readFileSync(o.rubric, "utf8"),
    model: config.models.score,
    rowsDir: rowsDir(),
    casesDir: casesDir(),
    runId: `score-${Date.now()}`,
    workflowVersion: o.workflowVersion,
  };
  const result = await scoreVideo(deps, {
    id,
    source: o.source ?? null,
    title: o.title ?? frontMatterTitle(transcriptPath) ?? id,
    transcriptPath,
    outputPath: o.out ? path.resolve(o.out) : path.join(path.dirname(transcriptPath), `${id}.score.json`),
    durationSeconds: o.duration,
  });
  write(result.ok ? `scored ${id}: ${result.card!.total}/15, $${result.costUsd.toFixed(4)}` : `score failed for ${id}: ${result.errorClass}`);
  if (!result.ok) throw new CommanderError(EXIT_SCORE, "score.failed", result.errorClass ?? "failed");
}

interface ScoreOptions {
  transcript: string;
  rubric: string;
  title?: string;
  out?: string;
  source?: string;
  duration?: number;
  workflowVersion: string;
}

/** Exit code for a score call that produced no card. */
export const EXIT_SCORE = 2;

function frontMatterTitle(file: string): string | undefined {
  return /^title:\s*"?(.*?)"?\s*$/m.exec(readFileSync(file, "utf8").split("\n---\n")[0] ?? "")?.[1];
}

export async function runCli(
  argv: string[],
  write: Write = console.log,
  writeErr: Write = console.error,
  scoreRunner: ScoreRunner = claudeScoreRunner,
): Promise<number> {
  const program = new Command("titan-yt-scout").exitOverride().configureOutput({ writeOut: write, writeErr });
  addConfigCommand(program, write);
  addSeenCommand(program, write);
  addScoreCommand(program, write, scoreRunner);
  addEvalCommands(program, write, scoreRunner);
  try {
    await program.parseAsync(argv, { from: "user" });
    return 0;
  } catch (err) {
    if (err instanceof CommanderError) return err.exitCode;
    if (err instanceof WatchlistError) {
      writeErr(err.message);
      return EXIT_CONFIG;
    }
    throw err;
  }
}
