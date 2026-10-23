import { writeFileSync } from "node:fs";
import { Command, CommanderError, InvalidArgumentError } from "commander";
import { floorSection, measureAaFloor, writeFloorNotes } from "./aa-floor.js";
import { hostFor, sampleCount, type RunCliDeps } from "./workflow/run-cli.js";
import { loadCases } from "./workflow/samples-cases.js";
import { sampledStage, sampleEnv, withSampleSettings, type SampleSettings } from "./workflow/samples-cli.js";
import type { CachedStage } from "./workflow/records.js";

interface AaFloorFlags extends SampleSettings {
  stage: CachedStage;
  cases: string[];
  split: string;
  samples: number;
  unitDir?: string;
  out?: string;
  maxUsd?: number;
}

function aaFloorCommand(deps: RunCliDeps, out: (text: string) => void, err: (text: string) => void, onResult: (code: number) => void): Command {
  return withSampleSettings(new Command("aa-floor")
    .description("Measure a model stage's noise floor: its champion against itself, n samples per arm over the dev cases, with σ per target row")
    .requiredOption("--stage <stage>", "the stage: script, rewrite")
    .requiredOption("--cases <paths...>", "titan.case/v1 files or cases directories (e.g. products/evals/units/explainer-script/cases)")
    .option("--split <split>", 'the case split to run, or "all"', "dev")
    .option("--samples <n>", "samples per case and arm", sampleCount, 3)
    .option("--unit-dir <dir>", "the stage's ev unit directory: writes σ to its notes.md and the floor to its aa-floor.json")
    .option("--out <file>", "also write the floor JSON here"))
    .exitOverride()
    .action(async (flags: AaFloorFlags) => {
      const stage = sampledStage(flags.stage);
      const cases = loadCases(flags.cases, flags.split === "all" ? undefined : flags.split);
      const env = sampleEnv(stage, flags, hostFor(flags, deps), undefined, err);
      const floor = await measureAaFloor({ stage, cases, samplesPerArm: flags.samples, now: () => new Date(), ...(flags.maxUsd === undefined ? {} : { maxUsd: flags.maxUsd }) }, env);
      if (flags.unitDir) writeFloorNotes(flags.unitDir, floor);
      if (flags.out) writeFileSync(flags.out, `${JSON.stringify(floor, null, 2)}\n`);
      out(`${floorSection(floor)}\n`);
      onResult(floor.stopped || floor.failedRuns > 0 ? 1 : 0);
    });
}

/** `explainer aa-floor --stage s --cases dir`: exit 0 when every run made its script, 1 otherwise, 2 on usage. */
export async function runAaFloorCli(argv: readonly string[], deps: RunCliDeps = {}): Promise<number> {
  const out = deps.out ?? ((text: string) => process.stdout.write(text));
  const err = deps.err ?? ((text: string) => process.stderr.write(text));
  let code = 0;
  const program = new Command("explainer").exitOverride().configureOutput({ writeOut: out, writeErr: err })
    .addCommand(aaFloorCommand(deps, out, err, (next) => (code = next)));
  try {
    await program.parseAsync([...argv], { from: "user" });
    return code;
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error instanceof InvalidArgumentError) err(`aa-floor: ${error.message}\n`);
      return error.exitCode === 0 ? 0 : 2;
    }
    err(`aa-floor: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
