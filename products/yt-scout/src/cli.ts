import { Command, CommanderError } from "commander";
import { isOnTrial, type Watchlist } from "./config.js";
import { createDetector, detectNew, formatDetected, insertNew, realDeps, type DetectDeps } from "./detect.js";
import { configPath, dbPath, rowsDir, ytRoot } from "./paths.js";
import { appendRows, type StepRow } from "./rows.js";
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

function addDetectCommand(program: Command, write: Write, makeDeps: (onRow: DetectDeps["onRow"]) => DetectDeps): void {
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
      try {
        const rows: StepRow[] = [];
        const detector = createDetector(makeDeps((row) => rows.push(row)), watchlist.defaults.tabs);
        const now = new Date();
        const found = await detectNew(db, watchlist, detector, now);
        appendRows(opts.rowsDir ?? rowsDir(), rows);
        for (const line of formatDetected(found)) write(line);
        if (!opts.dryRun) write(`inserted ${insertNew(db, found, now)}`);
        write(`rss fallbacks: ${rows.length}`);
      } finally {
        db.close();
      }
    });
}

export async function runCli(
  argv: string[],
  write: Write = console.log,
  writeErr: Write = console.error,
  makeDeps: (onRow: DetectDeps["onRow"]) => DetectDeps = realDeps,
): Promise<number> {
  const program = new Command("titan-yt-scout").exitOverride().configureOutput({ writeOut: write, writeErr });
  addConfigCommand(program, write);
  addSeenCommand(program, write);
  addDetectCommand(program, write, makeDeps);
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
