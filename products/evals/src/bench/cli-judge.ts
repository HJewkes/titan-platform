import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Command, CommanderError } from "commander";
import { z } from "zod";
import { planBatches, readItemRows, runBatch, secondJudgeAgreement } from "./judge/batch.js";
import { claudePrintJudge } from "./judge/core.js";
import { generateFaControls } from "./judge/review-fa-controls.js";
import { falseAlarmItems, parseFaControls, type FaSource } from "./judge/review-fa.js";
import { loadReviewQueue, type ReviewCase } from "./review/cases.js";
import { writeBundle } from "./review/job.js";
import { cloneGitFor, collectRepoRoot } from "./review/repos.js";

interface ReviewFaFlags {
  run: string;
  bundles?: string;
  cases?: string;
  repoRoot?: Record<string, string>;
  controls: string;
  out?: string;
  configDir?: string;
  limitBatches?: number;
}

interface ControlsFlags {
  cases: string;
  repoRoot?: Record<string, string>;
  out: string;
  n: number;
  seed: string;
}

function readJsonl(path: string): unknown[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as unknown);
}

const CliResult = z.looseObject({ result: z.string() });

/** A job's final message is the `result` of its saved CLI output; a bundle is `<bundles>/<caseId>/{head,diff.patch}`. */
function dirSource(runDir: string, bundlesDir: string): FaSource {
  return {
    review: (sessionId) => CliResult.parse(JSON.parse(readFileSync(join(runDir, "results", `${sessionId}.json`), "utf8"))).result,
    diff: (caseId) => readFileSync(join(bundlesDir, caseId, "diff.patch"), "utf8"),
    headLines: (caseId, path) => readFileSync(join(bundlesDir, caseId, "head", path), "utf8").split("\n"),
  };
}

const ScoredCase = z.looseObject({ caseId: z.string(), result: z.looseObject({ caseType: z.string(), falseAlarm: z.boolean().optional() }) });

const falseAlarmCaseIds = (scoreRows: readonly unknown[]): string[] => [
  ...new Set(
    scoreRows.flatMap((row) => {
      const parsed = ScoredCase.safeParse(row);
      return parsed.success && parsed.data.result.caseType === "clean" && parsed.data.result.falseAlarm === true ? [parsed.data.caseId] : [];
    }),
  ),
];

/** Items per false-alarm case from a bundle rebuilt for just that case and deleted once its items exist. */
async function itemsFromRebuiltBundles(flags: ReviewFaFlags, runDir: string, outDir: string, scores: readonly unknown[], jobs: readonly unknown[]) {
  if (flags.cases === undefined) throw new Error("pass --cases (with --repo-root) to rebuild the bundles, or --bundles for ones already on disk");
  const queue = new Map(loadReviewQueue(resolve(flags.cases)).map((benchCase) => [benchCase.id, benchCase]));
  const gitFor = cloneGitFor(flags.repoRoot ?? {});
  const scratch = join(outDir, "fa-bundles");
  const planned: ReturnType<typeof falseAlarmItems> = [];
  for (const caseId of falseAlarmCaseIds(scores)) {
    const benchCase: ReviewCase | undefined = queue.get(caseId);
    if (benchCase === undefined) throw new Error(`case ${caseId} is not in ${flags.cases}`);
    const dir = join(scratch, caseId);
    try {
      await writeBundle(benchCase, dir, gitFor);
      planned.push(...falseAlarmItems(scores.filter((row) => ScoredCase.safeParse(row).data?.caseId === caseId), jobs, dirSource(runDir, scratch)));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  return planned;
}

async function plannedItems(flags: ReviewFaFlags, runDir: string, outDir: string) {
  const scores = readJsonl(join(runDir, "scores.jsonl"));
  const jobs = readJsonl(join(runDir, "jobs.jsonl"));
  return flags.bundles === undefined ? itemsFromRebuiltBundles(flags, runDir, outDir, scores, jobs) : falseAlarmItems(scores, jobs, dirSource(runDir, resolve(flags.bundles)));
}

async function reviewFa(flags: ReviewFaFlags): Promise<boolean> {
  const configDir = flags.configDir ?? process.env.CLAUDE_CONFIG_DIR;
  if (configDir === undefined || configDir === "") throw new Error("--config-dir or CLAUDE_CONFIG_DIR names the profile the judge logs in with");
  const runDir = resolve(flags.run);
  const outDir = resolve(flags.out ?? runDir);
  const cwd = join(outDir, "judge-cwd");
  mkdirSync(cwd, { recursive: true });
  const ledgerPath = join(outDir, "judgments.jsonl");
  const done = new Set(readItemRows(ledgerPath).map((row) => row.key));
  const planned = await plannedItems(flags, runDir, outDir);
  const controls = parseFaControls(JSON.parse(readFileSync(flags.controls, "utf8")));
  const pending = planned.filter((entry) => !done.has(entry.item.key));
  const deps = { judge: claudePrintJudge({ configDir, cwd }), ledgerPath };
  let allPassed = true;
  const plans = planBatches("r-fa", pending, controls, controls.length > 1 ? 2 : 1);
  for (const plan of plans.slice(0, flags.limitBatches)) {
    const result = await runBatch(plan, deps);
    allPassed &&= result.outcome === "passed";
    console.error(JSON.stringify({ batch: result.batchId, outcome: result.outcome, items: result.items.length }));
  }
  console.error(JSON.stringify({ pending: pending.length, agreement: secondJudgeAgreement(readItemRows(ledgerPath)) }));
  return allPassed;
}

function reviewFaCommand(onResult: (code: number) => void): Command {
  return new Command("review-fa")
    .description("Judge whether each R false alarm's blocking finding is a real defect; appends to <out>/judgments.jsonl and resumes by item key")
    .requiredOption("--run <dir>", "the R run dir holding scores.jsonl, jobs.jsonl and results/")
    .option("--bundles <dir>", "case bundles as <dir>/<caseId>/{head,diff.patch}; overrides rebuilding them from --cases")
    .option("--cases <dir>", "the run's prepared cases (holds queue.jsonl); bundles are rebuilt under <out>/fa-bundles")
    .option("--repo-root <name=path>", "a local clone to bundle commits from, per repo name; repeatable", collectRepoRoot)
    .option("--limit-batches <n>", "stop after this many batches", (value) => Number.parseInt(value, 10))
    .requiredOption("--controls <controls.json>", "the R controls: a JSON array of findings, each with expected real or not-real")
    .option("--out <dir>", "where judgments.jsonl goes (default: the run dir)")
    .option("--config-dir <dir>", "the claude profile the judge logs in with (default: $CLAUDE_CONFIG_DIR)")
    .exitOverride()
    .action(async (flags: ReviewFaFlags) => {
      try {
        onResult((await reviewFa(flags)) ? 0 : 1);
      } catch (error) {
        if (error instanceof CommanderError) throw error;
        console.error(`bench judge review-fa: ${error instanceof Error ? error.message : String(error)}`);
        onResult(1);
      }
    });
}

async function reviewFaControls(flags: ControlsFlags): Promise<number> {
  const gitFor = cloneGitFor(flags.repoRoot ?? {});
  const queue = loadReviewQueue(resolve(flags.cases));
  const scratch = join(dirname(resolve(flags.out)), "fa-control-bundles");
  const controls = await generateFaControls(queue, flags.n, flags.seed, (benchCase, dir) => writeBundle(benchCase, dir, gitFor), scratch);
  writeFileSync(flags.out, `${JSON.stringify(controls, null, 2)}\n`);
  rmSync(scratch, { recursive: true, force: true });
  return controls.length;
}

function reviewFaControlsCommand(onResult: (code: number) => void): Command {
  return new Command("review-fa-controls")
    .description("Write the R false-alarm judge's controls: planted-defect findings (real) and false claims about unchanged lines (not real)")
    .requiredOption("--cases <dir>", "the run's prepared cases (holds queue.jsonl)")
    .option("--repo-root <name=path>", "a local clone to bundle commits from, per repo name; repeatable", collectRepoRoot)
    .requiredOption("--out <controls.json>", "where the controls go")
    .option("--n <count>", "how many controls, half real and half not real", (value) => Number.parseInt(value, 10), 12)
    .option("--seed <seed>", "the seed that picks the cases", "bench-2026-11")
    .exitOverride()
    .action(async (flags: ControlsFlags) => {
      try {
        console.error(JSON.stringify({ controls: await reviewFaControls(flags) }));
        onResult(0);
      } catch (error) {
        if (error instanceof CommanderError) throw error;
        console.error(`bench judge review-fa-controls: ${error instanceof Error ? error.message : String(error)}`);
        onResult(1);
      }
    });
}

/** Adds `judge` to the bench command; each judged track is one subcommand. */
export function registerJudge(program: Command, onResult: (code: number) => void): Command {
  const judge = new Command("judge").description("Judge stored bench outputs with a model no arm shares, under planted controls");
  return program.addCommand(judge.addCommand(reviewFaCommand(onResult)).addCommand(reviewFaControlsCommand(onResult)).exitOverride());
}
