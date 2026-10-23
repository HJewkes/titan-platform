import { readFileSync } from "node:fs";
import { appDirs } from "@titan-design/app-paths";
import { Command, CommanderError, InvalidArgumentError, Option } from "commander";
import { JudgeConfigSchema } from "../eval-harness.js";
import { MAX_REWRITE_ROUNDS } from "../rewrite-plan.js";
import { DEFAULT_BUDGET_USD, DEFAULT_SCRIPT_MODEL, resumeVideo, runVideo, writeReport, type RunHost, type RunOutcome } from "./host.js";
import { STAGES, type StageName } from "./records.js";
import { compareReports, renderCompare } from "./report.js";

const EXIT = { OK: 0, FAILED: 1, USAGE: 2 } as const;

interface RunFlags {
  dataDir?: string;
  spine?: string;
  facts?: string;
  from: StageName;
  to: StageName;
  base?: string;
  pin: Record<string, string>;
  variant: Partial<Record<StageName, string>>;
  sample: Partial<Record<StageName, number>>;
  video?: string;
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

/** `name=value`, collected into a map; `check` validates the pair. */
export function pairs<V>(flag: string, check: (name: string, value: string) => V) {
  return (text: string, acc: Record<string, V> = {}): Record<string, V> => {
    const at = text.indexOf("=");
    if (at <= 0 || at === text.length - 1) throw new InvalidArgumentError(`${flag} takes name=value, got "${text}"`);
    return { ...acc, [text.slice(0, at)]: check(text.slice(0, at), text.slice(at + 1)) };
  };
}

const SHA = /^[0-9a-f]{64}$/;
export const shaPair = (flag: string) => pairs(flag, (_name, value) => {
  if (!SHA.test(value)) throw new InvalidArgumentError(`${flag} needs a full sha256, got "${value}"`);
  return value;
});
const stageName = (flag: string, name: string): StageName => {
  const stage = STAGES.find((s) => s === name);
  if (!stage) throw new InvalidArgumentError(`${flag} names no stage "${name}"; stages: ${STAGES.join(", ")}`);
  return stage;
};

export function sampleIndex(text: string): number {
  const value = Number(text);
  if (!Number.isInteger(value) || value < 0) throw new InvalidArgumentError(`a sample index is an integer from 0, got "${text}"`);
  return value;
}

/** A unit slip (`--budget-usd 2000`) would otherwise lift the backstop the cap exists to be. */
export function budget(text: string): number {
  const value = Number(text);
  if (!Number.isFinite(value) || value <= 0 || value > 500) throw new InvalidArgumentError(`--budget-usd must be a number above 0 and at most 500, got "${text}"`);
  return value;
}

export function rounds(text: string): number {
  const value = Number(text);
  if (!Number.isInteger(value) || value < 1 || value > MAX_REWRITE_ROUNDS) throw new InvalidArgumentError(`--rounds must be an integer from 1 to ${MAX_REWRITE_ROUNDS}, got "${text}"`);
  return value;
}

export const dataDirOption = () => new Option("--data-dir <dir>", "run state, artifacts, run reports and the bridge host file bridge.json (default: the per-user data dir)");
export const hostFor = (flags: { dataDir?: string }, deps: RunCliDeps): RunHost => ({ ...deps.host, dataDir: flags.dataDir ?? appDirs("explainer").data });

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
    .addOption(new Option("--to <stage>", "last stage to run; a run that stops before export never reaches the theater").choices(STAGES).default("export"))
    .option("--base <runId>", "the run whose outputs stand in for the stages before --from (default: the latest run, unless --pin is given)")
    .option("--pin <name=sha>", "an artifact from the store, laid over the base run's (repeatable)", shaPair("--pin"), {})
    .option("--variant <stage=file>", "a stage variant file, explainer.variant/v1 (repeatable)", pairs("--variant", (name, file) => (stageName("--variant", name), file)), {})
    .option("--sample <stage=k>", "the sample index for a stage, part of its cache key (repeatable)", pairs("--sample", (name, k) => (stageName("--sample", name), sampleIndex(k))), {})
    .option("--video <id>", "the video this run belongs to (default: the base run's, or a new video)")
    .option("--budget-usd <usd>", "spend cap: a hard stop before the next stage once model spend reaches it", budget, DEFAULT_BUDGET_USD)
    .option("--script-model <model>", "model for the script stage", DEFAULT_SCRIPT_MODEL)
    .option("--judge <file>", "model config JSON for the rewrite stage, as for `explainer rewrite` (default: claude-print sonnet)")
    .option("--rounds <n>", `rewrite rounds, 1 to ${MAX_REWRITE_ROUNDS}`, rounds, MAX_REWRITE_ROUNDS)
    .exitOverride()
    .action(async (flags: RunFlags) => {
      const judge = flags.judge ? JudgeConfigSchema.parse(JSON.parse(readFileSync(flags.judge, "utf8"))) : undefined;
      const result = await runVideo({
        ...(flags.spine ? { spine: flags.spine } : {}), ...(flags.facts ? { facts: flags.facts } : {}), ...(flags.base ? { base: flags.base } : {}),
        ...(flags.video ? { video: flags.video } : {}), pins: flags.pin, variants: flags.variant, samples: flags.sample,
        from: flags.from, to: flags.to, budgetUsd: flags.budgetUsd, scriptModel: flags.scriptModel, ...(judge ? { judge } : {}), rounds: flags.rounds,
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
    .option("--compare <runId>", "also print each stage's spend and wall time delta, cache hits and changed output shas against this run")
    .exitOverride()
    .action((runId: string, flags: { dataDir?: string; json?: boolean; compare?: string }) => {
      const host = hostFor(flags, deps);
      const { report, reportPath } = writeReport(runId, host);
      const other = flags.compare ? writeReport(flags.compare, host).report : undefined;
      if (flags.json) io.out(`${JSON.stringify(other ? { ...report, compare: compareReports(other, report) } : report, null, 2)}\n`);
      else io.out(`${readFileSync(reportPath, "utf8")}${other ? `\n${renderCompare(other, report)}` : ""}`);
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
