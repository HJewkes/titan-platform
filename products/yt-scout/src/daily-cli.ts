import type { Command } from "commander";
import { runDaily, type ConsoleRunner } from "./daily.js";
import { inboxDir, readOwnerAnswer, shellConsoleRunner, sourceCardLoaders } from "./daily-sources.js";
import { casesDir, configPath, dbPath, rowsDir } from "./paths.js";
import { getVideo, openScoutDb } from "./store.js";
import { loadWatchlist } from "./watchlist.js";
import path from "node:path";

export function addDailyCommand(program: Command, write: (line: string) => void, runner: ConsoleRunner = shellConsoleRunner): void {
  program
    .command("daily")
    .description("File the day's know-item for the owner: top cards, yesterday's answer read into eval cases")
    .option("--workflow-version <sha>", "recorded on the row", "dev")
    .action(async (o: { workflowVersion: string }) => {
      const db = openScoutDb(dbPath());
      try {
        const loaders = sourceCardLoaders(rowsDir(), loadWatchlist(configPath()), (id) => getVideo(db, id), () => new Date());
        const out = await runDaily({
          runner,
          ...loaders,
          readAnswer: readOwnerAnswer(inboxDir()),
          casesDir: casesDir(),
          rowsDir: rowsDir(),
          stateDir: path.dirname(dbPath()),
          runId: `daily-${Date.now()}`,
          workflowVersion: o.workflowVersion,
        });
        write(out.outcome === "filed" ? `filed ${out.itemId}` : `skip${out.reason ? `: ${out.reason}` : ""}${out.itemId ? ` ${out.itemId}` : ""}`);
      } finally {
        db.close();
      }
    });
}
