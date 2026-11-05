import { readFileSync } from "node:fs";
import { Command, CommanderError, InvalidArgumentError, Option } from "commander";
import { readFloor } from "../aa-floor.js";
import { JudgeConfigSchema } from "../eval-harness.js";
import { measureTable, summarizeMeasure } from "../rewrite-measure.js";
import { MAX_REWRITE_ROUNDS } from "../rewrite-plan.js";
import { ArtifactStore } from "./artifacts.js";
import { DEFAULT_BUDGET_USD, DEFAULT_SCRIPT_MODEL, openState, runOneStage, type RunHost } from "./host.js";
import type { CachedStage } from "./records.js";
import { budget, dataDirOption, hostFor, rounds, sampleCount, type RunCliDeps } from "./run-cli.js";
import { loadCases } from "./samples-cases.js";
import { compareArms, compareTable } from "./samples-compare.js";
import { isSampledStage, runSamples, sampleRange, SAMPLED_STAGES, targetRowsOf, type SampledStage, type SampleEnv, type SampleResult } from "./samples-measure.js";

/** The run settings a sampled stage takes, shared by `stage --samples`, `ab` and `aa-floor`. */
export interface SampleSettings {
  dataDir?: string;
  budgetUsd: number;
  scriptModel: string;
  judge?: string;
  rounds: number;
}

/** The word that names the run's own settings in place of a variant file. */
export const CHAMPION = "champion";

export function sampledStage(stage: CachedStage): SampledStage {
  if (!isSampledStage(stage)) throw new InvalidArgumentError(`--samples measures a model stage that writes a script: ${Object.keys(SAMPLED_STAGES).join(", ")}; got ${stage}`);
  return stage;
}

/** Runs the stage through the stage cache and scores its output from the artifact store. */
export function sampleEnv(stage: SampledStage, settings: SampleSettings, host: RunHost, variant: string | undefined, log: (line: string) => void): SampleEnv {
  const judge = settings.judge ? JudgeConfigSchema.parse(JSON.parse(readFileSync(settings.judge, "utf8"))) : undefined;
  return {
    run: (inputs, sample) => runOneStage({
      stage, inputs: { ...inputs }, sample, budgetUsd: settings.budgetUsd, scriptModel: settings.scriptModel, rounds: settings.rounds,
      ...(variant && variant !== CHAMPION ? { variant } : {}), ...(judge ? { judge } : {}),
    }, host),
    score: (sha) => {
      const db = openState(host.dataDir);
      try {
        return targetRowsOf(new ArtifactStore(host.dataDir, db).readText(sha));
      } finally {
        db.close();
      }
    },
    log: (run) => log(`${JSON.stringify({ ...run, usd: Number(run.usd.toFixed(4)), totalUsd: Number(run.totalUsd.toFixed(4)) })}\n`),
  };
}

/** The settings options every sampled command takes. */
export function withSampleSettings(command: Command): Command {
  return command
    .addOption(dataDirOption())
    .option("--budget-usd <usd>", "bounds a model call inside the stage", budget, DEFAULT_BUDGET_USD)
    .option("--script-model <model>", "model for the script stage", DEFAULT_SCRIPT_MODEL)
    .option("--judge <file>", "model config JSON for the rewrite stage")
    .addOption(new Option("--rounds <n>", `rewrite rounds, 1 to ${MAX_REWRITE_ROUNDS}`).argParser(rounds).default(MAX_REWRITE_ROUNDS))
    .option("--max-usd <usd>", "stops before a run the dearest run so far says would take the total spend past it", budget);
}

/** A sampled measure's exit: 0 when every run made its script and none was skipped for spend, else 1. */
export const sampledExit = (results: readonly SampleResult[]): number =>
  results.some((result) => result.stopped || result.runs.some((run) => run.error)) ? 1 : 0;

export function spendLine(results: readonly SampleResult[]): string {
  const runs = results.flatMap((result) => result.runs);
  const stopped = results.find((result) => result.stopped)?.stopped;
  const failed = runs.filter((run) => run.error).length;
  const usd = results.reduce((sum, result) => sum + result.spentUsd, 0);
  return `Spend: $${usd.toFixed(4)} over ${runs.length} runs (${runs.filter((run) => run.cached).length} cache hits, ${failed} without a script).${stopped ? ` Stopped: ${stopped}.` : ""}\n`;
}

/** The line under a sampled measure's tables; the rewrite measure's own done-when names its task. */
export const ARM_VERDICT = "Every target row in band or within 1σ";

interface AbFlags extends SampleSettings {
  stage: CachedStage;
  variants: string[];
  cases: string[];
  split: string;
  samples: number;
  floor?: string;
  maxUsd?: number;
  json?: boolean;
}

async function runAb(flags: AbFlags, host: RunHost, out: (text: string) => void, err: (text: string) => void): Promise<number> {
  const stage = sampledStage(flags.stage);
  const [a = CHAMPION, b = CHAMPION] = flags.variants;
  const cases = loadCases(flags.cases, flags.split === "all" ? undefined : flags.split);
  const cap = flags.maxUsd === undefined ? {} : { maxUsd: flags.maxUsd };
  // The same settings on both arms would share cache keys; arm B then takes the next n sample indices.
  const offset = a === b ? flags.samples : 0;
  const armA = await runSamples({ stage, cases, samples: sampleRange(0, flags.samples), ...cap }, sampleEnv(stage, flags, host, a, err));
  const armB = armA.stopped ? { ...armA, inputs: [], runs: [], spentUsd: 0 } :
    await runSamples({ stage, cases, samples: sampleRange(offset, flags.samples), ...cap, prior: armA.runs }, sampleEnv(stage, flags, host, b, err));
  const floor = flags.floor ? readFloor(flags.floor) : undefined;
  if (floor && floor.stage !== stage) throw new InvalidArgumentError(`--floor is the ${floor.stage} stage's floor, not ${stage}'s`);
  const [summaryA, summaryB] = [summarizeMeasure(armA.inputs), summarizeMeasure(armB.inputs)];
  const rows = compareArms(summaryA, summaryB, floor?.sigma);
  if (flags.json) {
    const runs = { a: armA.runs, b: armB.runs };
    out(`${JSON.stringify({ stage, variants: { a, b }, cases: cases.map((c) => c.name), floor: floor?.sigma ?? null, rows, a: summaryA, b: summaryB, runs }, null, 2)}\n`);
  } else {
    const arms = `### A\n\n${measureTable(summaryA, ARM_VERDICT)}\n### B\n\n${measureTable(summaryB, ARM_VERDICT)}`;
    out(`## ${stage}: ${b} (B) against ${a} (A), ${flags.samples} samples per arm\n\n${compareTable(rows, { a: "A", b: "B" })}\n${arms}\n${spendLine([armA, armB])}`);
  }
  return sampledExit([armA, armB]);
}

function abCommand(deps: RunCliDeps, out: (text: string) => void, err: (text: string) => void, onResult: (code: number) => void): Command {
  return withSampleSettings(new Command("ab")
    .description("Run one model stage over frozen ev cases under two variants, n samples each, and judge each target row's difference against the noise floor")
    .requiredOption("--stage <stage>", `the stage: ${Object.keys(SAMPLED_STAGES).join(", ")}`)
    .requiredOption("--variants <files...>", `A then B: explainer.variant/v1 files, or "${CHAMPION}" for the run's own settings`)
    .requiredOption("--cases <paths...>", "titan.case/v1 files or cases directories (e.g. products/evals/units/explainer-script/cases)")
    .option("--split <split>", 'the case split to run, or "all"', "dev")
    .option("--samples <n>", "samples per case and arm", sampleCount, 3)
    .option("--floor <file>", "an A/A floor (aa-floor.json, or the unit directory holding it) whose σ judges the difference; default: the arms' own pooled σ")
    .option("--json", "print the comparison, both summaries and every run as JSON"))
    .exitOverride()
    .action(async (flags: AbFlags) => {
      if (flags.variants.length !== 2) throw new InvalidArgumentError(`--variants takes exactly two, A then B; got ${flags.variants.length}`);
      onResult(await runAb(flags, hostFor(flags, deps), out, err));
    });
}

/** `explainer ab --stage s --variants a b --cases dir --samples n`: exit 0 when every run made its script, 1 otherwise, 2 on usage. */
export async function runAbCli(argv: readonly string[], deps: RunCliDeps = {}): Promise<number> {
  const out = deps.out ?? ((text: string) => process.stdout.write(text));
  const err = deps.err ?? ((text: string) => process.stderr.write(text));
  let code = 0;
  const program = new Command("explainer").exitOverride().configureOutput({ writeOut: out, writeErr: err }).addCommand(abCommand(deps, out, err, (next) => (code = next)));
  try {
    await program.parseAsync([...argv], { from: "user" });
    return code;
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error instanceof InvalidArgumentError) err(`ab: ${error.message}\n`);
      return error.exitCode === 0 ? 0 : 2;
    }
    err(`ab: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
