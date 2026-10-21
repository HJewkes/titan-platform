import path from "node:path";
import { createHash } from "node:crypto";
import { appDirs } from "@titan-design/app-paths";
import { openDatabase } from "@titan-design/store-sqlite";
import { Command, CommanderError } from "commander";
import { indexCorpus, type IndexStats } from "./index-corpus.js";
import { BASELINE_USD } from "./cost/cost.js";
import { costReportText } from "./cost/command.js";
import { LAYOUTS } from "./layout.js";

/** One index per corpus root, so two corpora never share a database. */
export function defaultIndexPath(root: string): string {
  const key = createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 12);
  return path.join(appDirs("corpus-query").data, key, "index.sqlite3");
}

export function formatStats(s: IndexStats): string {
  return `documents ${s.documents}, indexed ${s.indexed}, unchanged ${s.unchanged}, removed ${s.removed}, skipped ${s.skipped}, headerless ${s.headerless}, paragraphs ${s.paragraphs}`;
}

export async function runCli(argv: string[], write: (line: string) => void = console.log): Promise<number> {
  const program = new Command("corpus-query").exitOverride().configureOutput({ writeOut: write, writeErr: write });
  program
    .command("index <root>")
    .description("Index a text corpus into a local paragraph search index")
    .option("--layout <name>", `corpus layout: ${Object.keys(LAYOUTS).join("|")}`, "archive")
    .option("--db <file>", "index database path (default: per-user data dir)")
    .action((root: string, opts: { layout: string; db?: string }) => {
      const layout = LAYOUTS[opts.layout];
      if (!layout) throw new CommanderError(2, "corpus-query.layout", `unknown layout "${opts.layout}"`);
      const db = openDatabase(opts.db ?? defaultIndexPath(root));
      try {
        write(formatStats(indexCorpus(db, path.resolve(root), layout)));
      } finally {
        db.close();
      }
    });
  program
    .command("cost <runId>")
    .description("Print a run's token and USD cost by stage and model, against the baseline")
    .option("--baseline-usd <usd>", "baseline cost to compare against", String(BASELINE_USD))
    .option("--runs-dir <dir>", "runs directory (default: per-user data dir)")
    .action((runId: string, opts: { baselineUsd: string; runsDir?: string }) => {
      const runsDir = opts.runsDir ?? path.join(appDirs("corpus-query").data, "runs");
      write(costReportText(runsDir, runId, Number(opts.baselineUsd)));
    });
  try {
    await program.parseAsync(argv, { from: "user" });
    return 0;
  } catch (err) {
    if (err instanceof CommanderError) return err.exitCode;
    throw err;
  }
}
