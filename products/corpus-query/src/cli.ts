import { readFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { appDirs } from "@titan-design/app-paths";
import { openDatabase } from "@titan-design/store-sqlite";
import { Command, CommanderError } from "commander";
import { indexCorpus, type IndexStats } from "./index-corpus.js";
import { LAYOUTS } from "./layout.js";
import { DEFAULT_WINDOW, readPassage, retrieve } from "./retrieve.js";
import { QuerySpecSchema } from "./types.js";

const TermsFileSchema = QuerySpecSchema.pick({ termGroups: true, phrases: true, seedLexicon: true }).partial();

/** One local line per passage for a human read: `ref | locator | context`. */
export function formatHit(ref: string, first: number, last: number, paragraphs: string[]): string {
  return `${ref} | p${first}-${last} | ${paragraphs.join(" ¶ ").replace(/\s+/g, " ")}`;
}

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
    .command("hits <root>")
    .description("List passages matching a spec or phrase, with no model call")
    .option("--spec <file>", "JSON file with termGroups, phrases and/or seedLexicon")
    .option("--phrase <text>", "match this phrase")
    .option("--window <n>", "paragraphs of context either side of a hit", String(DEFAULT_WINDOW))
    .option("--summary", "print counts only")
    .option("--db <file>", "index database path (default: per-user data dir)")
    .action((root: string, opts: { spec?: string; phrase?: string; window: string; summary?: boolean; db?: string }) => {
      if ((opts.spec === undefined) === (opts.phrase === undefined)) throw new CommanderError(2, "corpus-query.hits", "give exactly one of --spec or --phrase");
      const terms = opts.spec === undefined ? { phrases: [opts.phrase!] } : TermsFileSchema.parse(JSON.parse(readFileSync(opts.spec, "utf8")));
      const db = openDatabase(opts.db ?? defaultIndexPath(root));
      try {
        const { passages, hitParagraphs } = retrieve(db, terms, { window: Number(opts.window) });
        if (opts.summary) {
          write(`hit paragraphs ${hitParagraphs}, passages ${passages.length}, chapters ${new Set(passages.map((p) => p.chapterId)).size}`);
          return;
        }
        for (const p of passages) write(formatHit(p.ref, p.firstParagraph, p.lastParagraph, readPassage(db, path.resolve(root), p)));
      } finally {
        db.close();
      }
    });
  try {
    await program.parseAsync(argv, { from: "user" });
    return 0;
  } catch (err) {
    if (err instanceof CommanderError) return err.exitCode;
    throw err;
  }
}
