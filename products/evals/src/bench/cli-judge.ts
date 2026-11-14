import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Command, CommanderError } from "commander";
import { z } from "zod";
import { planBatches, readItemRows, runBatch, secondJudgeAgreement } from "./judge/batch.js";
import { claudePrintJudge } from "./judge/core.js";
import { falseAlarmItems, parseFaControls, type FaSource } from "./judge/review-fa.js";

interface ReviewFaFlags {
  run: string;
  bundles: string;
  controls: string;
  out?: string;
  configDir?: string;
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

async function reviewFa(flags: ReviewFaFlags): Promise<boolean> {
  const configDir = flags.configDir ?? process.env.CLAUDE_CONFIG_DIR;
  if (configDir === undefined || configDir === "") throw new Error("--config-dir or CLAUDE_CONFIG_DIR names the profile the judge logs in with");
  const runDir = resolve(flags.run);
  const outDir = resolve(flags.out ?? runDir);
  const cwd = join(outDir, "judge-cwd");
  mkdirSync(cwd, { recursive: true });
  const ledgerPath = join(outDir, "judgments.jsonl");
  const done = new Set(readItemRows(ledgerPath).map((row) => row.key));
  const planned = falseAlarmItems(readJsonl(join(runDir, "scores.jsonl")), readJsonl(join(runDir, "jobs.jsonl")), dirSource(runDir, resolve(flags.bundles)));
  const controls = parseFaControls(JSON.parse(readFileSync(flags.controls, "utf8")));
  const pending = planned.filter((entry) => !done.has(entry.item.key));
  const deps = { judge: claudePrintJudge({ configDir, cwd }), ledgerPath };
  let allPassed = true;
  for (const plan of planBatches("r-fa", pending, controls, controls.length > 1 ? 2 : 1)) {
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
    .requiredOption("--bundles <dir>", "case bundles as <dir>/<caseId>/{head,diff.patch}")
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

/** Adds `judge` to the bench command; each judged track is one subcommand. */
export function registerJudge(program: Command, onResult: (code: number) => void): Command {
  return program.addCommand(new Command("judge").description("Judge stored bench outputs with a model no arm shares, under planted controls").addCommand(reviewFaCommand(onResult)).exitOverride());
}
