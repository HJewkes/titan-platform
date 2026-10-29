import { readFileSync } from "node:fs";
import path from "node:path";
import { Command, CommanderError } from "commander";
import { isOnTrial, type Watchlist } from "./config.js";
import { claudeScoreRunner } from "./claude-runner.js";
import { addDailyCommand } from "./daily-cli.js";
import type { ConsoleRunner } from "./daily.js";
import { createDetector, detectNew, formatDetected, insertNew, realDeps, resolveYtDlp, type DetectDeps } from "./detect.js";
import { casesDir, configPath, dbPath, rowsDir, ytRoot } from "./paths.js";
import { appendRows, type StepRow } from "./rows.js";
import { scoreVideo, type ScoreDeps } from "./score.js";
import type { ScoreRunner } from "./seams.js";
import { formatSeenImport, importSeen } from "./seen-import.js";
import { openScoutDb } from "./store.js";
import { loadWatchlist, WatchlistError } from "./watchlist.js";

type Write = (line: string) => void;
type MakeDeps = (onRow: DetectDeps["onRow"], ytDlpBin: string) => DetectDeps;

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

function addDetectCommand(program: Command, write: Write, makeDeps: MakeDeps): void {
  program
    .command("detect")
    .description("Poll the watch list and list ids not yet in the videos table")
    .option("--dry-run", "list new ids without inserting them")
    .option("--config <file>", "watch list")
    .option("--db <file>", "scout database")
    .option("--rows-dir <dir>", "step rows directory (default: beside the database)")
    .action(async (opts: { dryRun?: boolean; config?: string; db?: string; rowsDir?: string }) => {
      const watchlist = loadWatchlist(opts.config ?? configPath());
      const db = openScoutDb(opts.db ?? dbPath());
      const rows: StepRow[] = [];
      try {
        const detector = createDetector(makeDeps((row) => rows.push(row), resolveYtDlp(watchlist.yt_dlp)), watchlist.defaults.tabs);
        const now = new Date();
        const found = await detectNew(db, watchlist, detector, now);
        for (const line of formatDetected(found)) write(line);
        if (!opts.dryRun) write(`inserted ${insertNew(db, found, now)}`);
        write(`rss fallbacks: ${rows.filter((r) => r.outcome === "fallback").length}`);
        write(`listing failures: ${rows.filter((r) => r.outcome === "fail").length}`);
      } finally {
        appendRows(opts.rowsDir ?? rowsDir(), rows);
        db.close();
      }
    });
}

export async function runCli(
  argv: string[],
  write: Write = console.log,
  writeErr: Write = console.error,
  scoreRunner: ScoreRunner = claudeScoreRunner,
  makeDeps: MakeDeps = realDeps,
  consoleRunner?: ConsoleRunner,
): Promise<number> {
  const program = new Command("titan-yt-scout").exitOverride().configureOutput({ writeOut: write, writeErr });
  addConfigCommand(program, write);
  addSeenCommand(program, write);
  addDetectCommand(program, write, makeDeps);
  addScoreCommand(program, write, scoreRunner);
  addDailyCommand(program, write, consoleRunner);
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
