import { readFileSync } from "node:fs";
import { Argument, Command, CommanderError, Option } from "commander";
import { JudgeConfigSchema } from "../eval-harness.js";
import { MAX_REWRITE_ROUNDS } from "../rewrite-plan.js";
import { DEFAULT_BUDGET_USD, DEFAULT_SCRIPT_MODEL, runOneStage } from "./host.js";
import { CACHED_STAGES, type CachedStage } from "./records.js";
import { budget, dataDirOption, hostFor, rounds, sampleIndex, shaPair, type RunCliDeps } from "./run-cli.js";

interface StageFlags {
  dataDir?: string;
  in: Record<string, string>;
  variant?: string;
  sample: number;
  budgetUsd: number;
  scriptModel: string;
  judge?: string;
  rounds: number;
  json?: boolean;
}

const shortShas = (outputs: Record<string, string>): string => Object.entries(outputs).map(([name, sha]) => `${name}=${sha}`).join(" ");

function stageCommand(deps: RunCliDeps, out: (text: string) => void): Command {
  return new Command("stage")
    .description("Run one stage from stored artifacts as its own child run, through the stage cache, and print its outputs and report row")
    .addArgument(new Argument("<name>", "the stage").choices(CACHED_STAGES))
    .addOption(dataDirOption())
    .option("--in <name=sha>", "an input artifact from the store (repeatable)", shaPair("--in"), {})
    .option("--variant <file>", "a variant file for this stage, explainer.variant/v1")
    .option("--sample <k>", "sample index, part of the cache key", sampleIndex, 0)
    .option("--budget-usd <usd>", "bounds a model call inside the stage", budget, DEFAULT_BUDGET_USD)
    .option("--script-model <model>", "model for the script stage", DEFAULT_SCRIPT_MODEL)
    .option("--judge <file>", "model config JSON for the rewrite stage")
    .addOption(new Option("--rounds <n>", `rewrite rounds, 1 to ${MAX_REWRITE_ROUNDS}`).argParser(rounds).default(MAX_REWRITE_ROUNDS))
    .option("--json", "print the stage record JSON")
    .exitOverride()
    .action(async (stage: CachedStage, flags: StageFlags) => {
      const judge = flags.judge ? JudgeConfigSchema.parse(JSON.parse(readFileSync(flags.judge, "utf8"))) : undefined;
      const record = await runOneStage({
        stage, inputs: flags.in, sample: flags.sample, budgetUsd: flags.budgetUsd, scriptModel: flags.scriptModel, rounds: flags.rounds,
        ...(flags.variant ? { variant: flags.variant } : {}), ...(judge ? { judge } : {}),
      }, hostFor(flags, deps));
      if (flags.json) return out(`${JSON.stringify(record, null, 2)}\n`);
      out(`stage ${stage}: ${record.cached ? "cache hit" : "ran"}; child run ${record.childRunId}; key ${record.key}\n`);
      out(`$${record.usage.usd.toFixed(4)} over ${record.usage.calls} model calls; ${(record.wallMs / 1000).toFixed(1)} s\n`);
      out(`outputs: ${shortShas(record.outputs)}\n`);
    });
}

/** `explainer stage <name> --in name=sha ...`: exit 0 when the stage finished, 1 when it failed, 2 on usage. */
export async function runStageCli(argv: readonly string[], deps: RunCliDeps = {}): Promise<number> {
  const out = deps.out ?? ((text: string) => process.stdout.write(text));
  const err = deps.err ?? ((text: string) => process.stderr.write(text));
  const program = new Command("explainer").exitOverride().configureOutput({ writeOut: out, writeErr: err }).addCommand(stageCommand(deps, out));
  try {
    await program.parseAsync([...argv], { from: "user" });
    return 0;
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode === 0 ? 0 : 2;
    err(`stage: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
