import { readFileSync } from "node:fs";
import { appDirs } from "@titan-design/app-paths";
import { Command, CommanderError, InvalidArgumentError, Option } from "commander";
import { JudgeConfigSchema } from "../eval-harness.js";
import { MAX_REWRITE_ROUNDS } from "../rewrite-plan.js";
import { DEFAULT_BUDGET_USD, DEFAULT_SCRIPT_MODEL, resumeVideo, runVideo, writeReport, type RunHost, type RunOutcome } from "./host.js";
import { STAGES, type StageName } from "./records.js";

const EXIT = { OK: 0, FAILED: 1, USAGE: 2 } as const;

interface RunFlags {
  dataDir?: string;
  spine?: string;
  facts?: string;
  from: StageName;
  base?: string;
  budgetUsd: number;
  scriptModel: string;
  judge?: string;
  rounds: number;
}

/** Everything but the data dir is injectable, so the CLI runs on fakes in a test. */
export interface RunCliDeps {
  host?: Omit<RunHost, "dataDir">;
  out?: (text: string) => void;
  err?: (text: string) => void;
}

type Io = Required<Pick<RunCliDeps, "out" | "err">>;

/** A unit slip (`--budget-usd 2000`) would otherwise lift the backstop the cap exists to be. */
function budget(text: string): number {
  const value = Number(text);
  if (!Number.isFinite(value) || value <= 0 || value > 500) throw new InvalidArgumentError(`--budget-usd must be a number above 0 and at most 500, got "${text}"`);
  return value;
}

function rounds(text: string): number {
  const value = Number(text);
  if (!Number.isInteger(value) || value < 1 || value > MAX_REWRITE_ROUNDS) throw new InvalidArgumentError(`--rounds must be an integer from 1 to ${MAX_REWRITE_ROUNDS}, got "${text}"`);
  return value;
}

const dataDirOption = () => new Option("--data-dir <dir>", "run state, artifacts, run reports and the bridge host file bridge.json (default: the per-user data dir)");
const hostFor = (flags: { dataDir?: string }, deps: RunCliDeps): RunHost => ({ ...deps.host, dataDir: flags.dataDir ?? appDirs("explainer").data });

function summary(result: RunOutcome, io: Io): number {
  const t = result.report.totals;
  io.out(`run ${result.runId}: ${result.status}; $${t.usd.toFixed(4)} over ${t.calls} model calls; ${(result.report.runWallMs / 1000).toFixed(1)} s\n`);
  io.out(`report: ${result.reportPath}\n`);
  if (result.error) io.err(`${result.error}\n`);
  if (result.status !== "completed") io.err(`continue with: explainer run resume ${result.runId}\n`);
  return result.status === "completed" ? EXIT.OK : EXIT.FAILED;
}

function runCommand(deps: RunCliDeps, io: Io, onResult: (code: number) => void): Command {
  return new Command("run")
    .description("Make one explainer video end to end on the workflow runtime, then write run-report.md (see also `run report --help`, `run resume --help`)")
    .addOption(dataDirOption())
    .option("--spine <file>", "story spine markdown; required from script unless --base supplies it")
    .option("--facts <file>", "facts pack markdown; required from script unless --base supplies it")
    .addOption(new Option("--from <stage>", "first stage to run; earlier stages reuse the base run's outputs").choices(STAGES).default("script"))
    .option("--base <runId>", "the run whose outputs stand in for the stages before --from (default: the latest run)")
    .option("--budget-usd <usd>", "spend cap: a hard stop before the next stage once model spend reaches it", budget, DEFAULT_BUDGET_USD)
    .option("--script-model <model>", "model for the script stage", DEFAULT_SCRIPT_MODEL)
    .option("--judge <file>", "model config JSON for the rewrite stage, as for `explainer rewrite` (default: claude-print sonnet)")
    .option("--rounds <n>", `rewrite rounds, 1 to ${MAX_REWRITE_ROUNDS}`, rounds, MAX_REWRITE_ROUNDS)
    .exitOverride()
    .action(async (flags: RunFlags) => {
      const judge = flags.judge ? JudgeConfigSchema.parse(JSON.parse(readFileSync(flags.judge, "utf8"))) : undefined;
      const result = await runVideo({
        ...(flags.spine ? { spine: flags.spine } : {}), ...(flags.facts ? { facts: flags.facts } : {}), ...(flags.base ? { base: flags.base } : {}),
        from: flags.from, budgetUsd: flags.budgetUsd, scriptModel: flags.scriptModel, ...(judge ? { judge } : {}), rounds: flags.rounds,
      }, hostFor(flags, deps));
      onResult(summary(result, io));
    });
}

function reportCommand(deps: RunCliDeps, io: Io, onResult: (code: number) => void): Command {
  return new Command("report")
    .description("Fold a run's stage records into run-report.md and run-report.json in its run directory")
    .argument("<runId>")
    .addOption(dataDirOption())
    .option("--json", "print the report JSON instead of the markdown")
    .exitOverride()
    .action((runId: string, flags: { dataDir?: string; json?: boolean }) => {
      const { report, reportPath } = writeReport(runId, hostFor(flags, deps));
      io.out(flags.json ? `${JSON.stringify(report, null, 2)}\n` : `${readFileSync(reportPath, "utf8")}`);
      onResult(EXIT.OK);
    });
}

function resumeCommand(deps: RunCliDeps, io: Io, onResult: (code: number) => void): Command {
  return new Command("resume")
    .description("Pick a run up: drive a crashed run on, or start a linked run from the stage a stopped or failed run did not finish")
    .argument("<runId>")
    .addOption(dataDirOption())
    .option("--budget-usd <usd>", "a new spend cap for the resumed run", budget)
    .exitOverride()
    .action(async (runId: string, flags: { dataDir?: string; budgetUsd?: number }) => {
      onResult(summary(await resumeVideo(runId, hostFor(flags, deps), flags.budgetUsd === undefined ? {} : { budgetUsd: flags.budgetUsd }), io));
    });
}

/** `explainer run [...]`, `explainer run report <runId>`, `explainer run resume <runId>`: exit 0 on a completed run, 1 on a stopped or failed one, 2 on usage. */
export async function runRunCli(argv: readonly string[], deps: RunCliDeps = {}): Promise<number> {
  const io: Io = { out: deps.out ?? ((text) => process.stdout.write(text)), err: deps.err ?? ((text) => process.stderr.write(text)) };
  let code: number = EXIT.OK;
  const onResult = (next: number): void => {
    code = next;
  };
  const program = new Command("explainer").exitOverride().configureOutput({ writeOut: io.out, writeErr: io.err });
  // `run` takes options of its own, so report and resume each get their own `run` node, as `rewrite measure` does.
  const sub = argv[1] === "report" ? reportCommand : argv[1] === "resume" ? resumeCommand : undefined;
  program.addCommand(sub ? new Command("run").addCommand(sub(deps, io, onResult)) : runCommand(deps, io, onResult));
  try {
    await program.parseAsync([...argv], { from: "user" });
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode === 0 ? EXIT.OK : EXIT.USAGE;
    io.err(`run: ${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT.USAGE;
  }
  return code;
}
