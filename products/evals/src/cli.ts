import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Command, CommanderError, InvalidArgumentError } from "commander";
import { z } from "zod";
import { buildCorpus, labelHistogram, type CorpusRow } from "./corpus/index.js";
import { historyCommand } from "./history/command.js";
import { defaultPolicy, selfTest } from "./private/exclusion.js";
import { buildReviewPrCases } from "./review-pr/build-cases.js";
import { exportImplementTaskCases, selectExportPool } from "./implement-task/export.js";
import { localCloneGit } from "./review-pr/bundle.js";
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

interface ReviewPrCasesFlags {
  corpus: string;
  repo: Map<string, string>;
  activeWorkRoot: string;
  out: string;
  mainRef: string;
  seed: string;
  selftest?: boolean;
}

/** The fields the builder keys on; a row missing one is a corpus from another tool, refused by line number. */
const CorpusRowKeys = z.looseObject({ repo: z.string(), pr: z.number(), head: z.string(), label: z.string(), citedPaths: z.array(z.string()) });
const isCorpusRow = (value: unknown): value is CorpusRow => CorpusRowKeys.safeParse(value).success;

function readCorpus(path: string): CorpusRow[] {
  const lines = readFileSync(path, "utf8").split("\n");
  return lines.flatMap((line, index) => {
    if (line.trim() === "") return [];
    const row: unknown = JSON.parse(line);
    if (!isCorpusRow(row)) throw new Error(`${path}:${index + 1} is not an outcome-corpus row`);
    return [row];
  });
}

async function writeReviewPrCases(flags: ReviewPrCasesFlags): Promise<void> {
  const policy = defaultPolicy(flags.activeWorkRoot);
  if (flags.selftest) {
    const result = selfTest(policy);
    console.error(JSON.stringify({ selftest: result }));
    if (!result.ok) throw new Error("the private exclusion self-test failed; no case was written");
  }
  const gitFor = (repo: string) => mapDefined(flags.repo.get(repo), localCloneGit);
  const manifest = await buildReviewPrCases(readCorpus(flags.corpus), { outDir: flags.out, policy, gitFor, mainRef: flags.mainRef, seed: flags.seed });
  console.error(JSON.stringify(manifest));
}

const mapDefined = <T, U>(value: T | undefined, fn: (value: T) => U): U | undefined => (value === undefined ? undefined : fn(value));

function reviewPrCommand(onResult: (code: number) => void): Command {
  const cases = new Command("cases")
    .description("Build private review-pr cases from the outcome corpus: defect heads, clean heads, planted controls, a suite and a manifest")
    .requiredOption("--corpus <jsonl>", "the JSONL `titan-evals corpus` wrote")
    .option("--repo <owner/repo=dir>", "a local clone for a repo; repeatable", collectClone, new Map<string, string>())
    .requiredOption("--active-work-root <dir>", "the active-work root the private markers are read from")
    .requiredOption("--out <dir>", "an empty dir outside every git work tree")
    .option("--main-ref <ref>", "the ref holding each repo's main history", "origin/main")
    .option("--seed <text>", "seeds splits and control placement", "review-pr")
    .option("--selftest", "run the private exclusion self-test first and abort if it fails")
    .exitOverride()
    .action(async (flags: ReviewPrCasesFlags) => {
      try {
        await writeReviewPrCases(flags);
        onResult(EXIT.OK);
      } catch (error) {
        if (error instanceof CommanderError) throw error;
        console.error(`review-pr cases: ${error instanceof Error ? error.message : String(error)}`);
        onResult(EXIT.FAILURE);
      }
    });
  return new Command("review-pr").description("The review-pr unit's private case builder").addCommand(cases).exitOverride();
}

interface ImplementTaskExportFlags {
  corpus: string;
  repo: Map<string, string>;
  reposRoot?: string;
  owner: string;
  activeWorkRoot: string;
  out?: string;
  classes: string;
  perClass: number;
  seed: string;
  maxCandidates?: number;
  dryRun?: boolean;
  selftest?: boolean;
}

const positiveInt = (value: string): number => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new InvalidArgumentError("expected a positive integer");
  return parsed;
};

function cloneLookup(flags: ImplementTaskExportFlags): (repo: string) => string | undefined {
  return (repo) => {
    const explicit = flags.repo.get(repo);
    if (explicit !== undefined) return explicit;
    const guess = flags.reposRoot === undefined ? undefined : join(flags.reposRoot, repo.slice(repo.lastIndexOf("/") + 1));
    return guess !== undefined && existsSync(guess) ? guess : undefined;
  };
}

async function runImplementTaskExport(flags: ImplementTaskExportFlags): Promise<void> {
  const policy = defaultPolicy(flags.activeWorkRoot);
  if (flags.selftest) {
    const result = selfTest(policy);
    console.error(JSON.stringify({ selftest: result }));
    if (!result.ok) throw new Error("the private exclusion self-test failed; no case was written");
  }
  const options = {
    corpus: flags.corpus,
    outDir: flags.out ?? "",
    policy,
    cloneFor: cloneLookup(flags),
    owner: flags.owner,
    classes: flags.classes.split(",").map((name) => name.trim()).filter((name) => name !== ""),
    perClass: flags.perClass,
    seed: flags.seed,
    maxCandidates: flags.maxCandidates,
  };
  if (flags.dryRun) {
    const pool = await selectExportPool(options);
    const counts = Object.fromEntries(Object.entries(pool.byClass).map(([cls, sources]) => [cls, sources.length]));
    console.error(JSON.stringify({ dryRun: { counts, dropped: pool.dropped.length, skipped: pool.skipped, excluded: pool.excluded, reposWithoutClone: pool.reposWithoutClone } }));
    return;
  }
  if (flags.out === undefined) throw new Error("--out is required unless --dry-run");
  console.error(JSON.stringify(await exportImplementTaskCases(options)));
}

function implementTaskCommand(onResult: (code: number) => void): Command {
  const exportCases = new Command("export")
    .description("Screen and write private implement-task cases from the classified corpus")
    .requiredOption("--corpus <jsonl>", "cases.v3.classified.jsonl; its sha256 goes in the manifest")
    .option("--repo <owner/repo=dir>", "a local clone for a repo; repeatable", collectClone, new Map<string, string>())
    .option("--repos-root <dir>", "find a repo with no --repo at <dir>/<repo name>")
    .option("--owner <name>", "prefixes a bare corpus repo name", "HJewkes")
    .requiredOption("--active-work-root <dir>", "the active-work root the private markers are read from")
    .option("--out <dir>", "an empty dir outside every git work tree; required unless --dry-run")
    .option("--classes <list>", "comma-separated task classes", "local-fix,feature-slice")
    .option("--per-class <n>", "kept cases per class", positiveInt, 8)
    .option("--seed <text>", "seeds the candidate order", "implement-task")
    .option("--max-candidates <n>", "caps each class's pool after filtering", positiveInt)
    .option("--dry-run", "select and filter only; no install, build or test")
    .option("--selftest", "run the private exclusion self-test first and abort if it fails")
    .exitOverride()
    .action(async (flags: ImplementTaskExportFlags) => {
      try {
        await runImplementTaskExport(flags);
        onResult(EXIT.OK);
      } catch (error) {
        if (error instanceof CommanderError) throw error;
        console.error(`implement-task export: ${error instanceof Error ? error.message : String(error)}`);
        onResult(EXIT.FAILURE);
      }
    });
  return new Command("implement-task").description("The implement-task unit's private case builder").addCommand(exportCases).exitOverride();
}

export function buildProgram(onResult: (code: number) => void = () => undefined): Command {
  return new Command("titan-evals")
    .description("Eval registry for units of work: specs, content hashes, and (in later slices) trials and scorecards")
    .addCommand(validateCommand(onResult))
    .addCommand(corpusCommand(onResult))
    .addCommand(historyCommand(onResult))
    .addCommand(reviewPrCommand(onResult))
    .addCommand(implementTaskCommand(onResult))
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
