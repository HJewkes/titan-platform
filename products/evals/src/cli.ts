import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Command, CommanderError, InvalidArgumentError } from "commander";
import { buildCorpus, labelHistogram } from "./corpus/index.js";
import { validateSpec } from "./validate.js";

/** Prompt paths are relative to the unit directory: the nearest ancestor holding unit.json. */
export function unitRootOf(specPath: string): string {
  let dir = dirname(resolve(specPath));
  while (!existsSync(join(dir, "unit.json"))) {
    const parent = dirname(dir);
    if (parent === dir) return dirname(resolve(specPath));
    dir = parent;
  }
  return dir;
}

const EXIT = { OK: 0, FAILURE: 1, USAGE: 2 } as const;

function validateCommand(onResult: (code: number) => void): Command {
  return new Command("validate")
    .description("Strict-parse spec files, re-read their prompts and print each content hash")
    .argument("<files...>", "unit, variant, case, suite or scorecard JSON files")
    .exitOverride()
    .action(async (files: string[]) => {
      let failed = false;
      for (const file of files) failed = !(await validateFile(file)) || failed;
      onResult(failed ? EXIT.FAILURE : EXIT.OK);
    });
}

/** Reports one file's result; a missing file, bad JSON or a schema error is reported, not thrown. */
async function validateFile(file: string): Promise<boolean> {
  try {
    const root = unitRootOf(file);
    const result = await validateSpec(JSON.parse(readFileSync(file, "utf8")), (path) => readFile(join(root, path)));
    console.log(`${result.hash}  ${result.schema}  ${file}${result.stalePrompts ? "  STALE prompt digest" : ""}`);
    return !result.stalePrompts;
  } catch (error) {
    console.error(`${file}: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

const collectClone = (value: string, clones: Map<string, string>): Map<string, string> => {
  const at = value.indexOf("=");
  if (at <= 0) throw new InvalidArgumentError("expected owner/repo=<clone dir>");
  return new Map(clones).set(value.slice(0, at), value.slice(at + 1));
};

interface CorpusFlags {
  db: string;
  repo: Map<string, string>;
  reposRoot?: string;
  mainRef?: string;
  now?: string;
  out?: string;
}

async function writeCorpus(flags: CorpusFlags): Promise<void> {
  const now = flags.now === undefined ? new Date() : new Date(flags.now);
  if (Number.isNaN(now.getTime())) throw new InvalidArgumentError(`--now is not a date: ${flags.now}`);
  const rows = await buildCorpus({ dbPath: flags.db, clones: flags.repo, reposRoot: flags.reposRoot, mainRef: flags.mainRef, now });
  const jsonl = rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length > 0 ? "\n" : "");
  if (flags.out) writeFileSync(flags.out, jsonl);
  else process.stdout.write(jsonl);
  console.error(JSON.stringify({ heads: rows.length, labels: labelHistogram(rows) }));
}

function corpusCommand(onResult: (code: number) => void): Command {
  return new Command("corpus")
    .description("Write the review outcome corpus as JSONL: one row per (repo, pr, head) with a verdict. Opens the factory database read-only")
    .requiredOption("--db <path>", "factory.sqlite3, opened with mode=ro")
    .option("--repo <owner/repo=dir>", "a local clone for a repo; repeatable", collectClone, new Map<string, string>())
    .option("--repos-root <dir>", "find a repo with no --repo at <dir>/<repo name>")
    .option("--main-ref <ref>", "the ref holding each repo's main history", "origin/main")
    .option("--now <iso>", "the time labels mature against (default: now)")
    .option("--out <file>", "write JSONL here instead of stdout; the summary goes to stderr")
    .exitOverride()
    .action(async (flags: CorpusFlags) => {
      try {
        await writeCorpus(flags);
        onResult(EXIT.OK);
      } catch (error) {
        if (error instanceof CommanderError) throw error;
        console.error(`corpus: ${error instanceof Error ? error.message : String(error)}`);
        onResult(EXIT.FAILURE);
      }
    });
}

export function buildProgram(onResult: (code: number) => void = () => undefined): Command {
  return new Command("titan-evals")
    .description("Eval registry for units of work: specs, content hashes, and (in later slices) trials and scorecards")
    .addCommand(validateCommand(onResult))
    .addCommand(corpusCommand(onResult))
    .exitOverride()
    .showHelpAfterError();
}

function exitCodeOf(error: unknown): number {
  if (!(error instanceof CommanderError)) throw error;
  return error.exitCode === 0 ? EXIT.OK : EXIT.USAGE;
}

export async function runCli(argv: string[]): Promise<number> {
  let code: number = EXIT.OK;
  const program = buildProgram((result) => void (code = result));
  if (argv.length === 0) {
    program.outputHelp();
    return code;
  }
  try {
    await program.parseAsync(argv, { from: "user" });
  } catch (error) {
    return exitCodeOf(error);
  }
  return code;
}
