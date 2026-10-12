import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { errorLine, messageOf } from "./context.js";
import { judge, type JudgeReports } from "./judge.js";
import { run, type RunOptions } from "./run.js";
import { execSide, type Side } from "./side.js";
import { MAX_ENCODED_BYTES } from "./transport.js";

const COMMON_USAGE = "--base <mergeBase> --head <sha> [--repo <dir>] [--budget-ms <n>]";
export const USAGE = `usage: fix-proof run|exec|judge ${COMMON_USAGE}`;
const RUN_USAGE = `usage: fix-proof run ${COMMON_USAGE}`;
const EXEC_USAGE = `usage: fix-proof exec --side base|head --out <dir> ${COMMON_USAGE}`;
const JUDGE_USAGE = `usage: fix-proof judge --base-report <file> --head-report <file> [--base-rerun-report <file>] ${COMMON_USAGE}`;

type Values = Partial<Record<string, string>>;
type Runner = typeof run;

interface Command {
  usage: string;
  flags: readonly string[];
  required: readonly string[];
  act: (values: Values, cwd: string, runner: Runner) => Promise<string>;
}

const COMMON_FLAGS = ["base", "head", "repo", "budget-ms"];

function common(values: Values, cwd: string): RunOptions {
  const options: RunOptions = { repo: values.repo ?? cwd, base: values.base ?? "", head: values.head ?? "" };
  if (values["budget-ms"] !== undefined) {
    const budgetMs = Number(values["budget-ms"]);
    if (!Number.isSafeInteger(budgetMs) || budgetMs <= 0) throw new Error("--budget-ms must be a positive integer");
    options.budgetMs = budgetMs;
  }
  return options;
}

function sideOf(value: string | undefined): Side {
  if (value === "base" || value === "head") return value;
  throw new Error(EXEC_USAGE);
}

// Reads at most a little past the decoder's cap, so an oversized report file is refused without loading it whole.
function readReport(file: string | undefined, cwd: string): string | undefined {
  if (file === undefined) return undefined;
  const resolved = path.resolve(cwd, file);
  if (!fs.existsSync(resolved)) return undefined;
  const fd = fs.openSync(resolved, "r");
  try {
    const buffer = Buffer.alloc(MAX_ENCODED_BYTES + 2);
    return buffer.subarray(0, fs.readSync(fd, buffer, 0, buffer.length, 0)).toString("utf-8");
  } finally {
    fs.closeSync(fd);
  }
}

function judgeReports(values: Values, cwd: string): JudgeReports {
  return {
    base: readReport(values["base-report"], cwd),
    baseRerun: readReport(values["base-rerun-report"], cwd),
    head: readReport(values["head-report"], cwd),
  };
}

const COMMANDS: Readonly<Record<string, Command>> = {
  run: { usage: RUN_USAGE, flags: [], required: [], act: (values, cwd, runner) => runner(common(values, cwd)) },
  exec: {
    usage: EXEC_USAGE,
    flags: ["side", "out"],
    required: ["side", "out"],
    act: async (values, cwd) => {
      await execSide({ ...common(values, cwd), side: sideOf(values.side), out: path.resolve(cwd, values.out ?? "") });
      return "";
    },
  },
  judge: {
    usage: JUDGE_USAGE,
    flags: ["base-report", "head-report", "base-rerun-report"],
    required: ["base-report", "head-report"],
    act: (values, cwd) => judge({ ...common(values, cwd), reports: judgeReports(values, cwd) }),
  },
};

function readValues(args: readonly string[], command: Command): Values {
  const flags = [...COMMON_FLAGS, ...command.flags];
  const options = Object.fromEntries(flags.map((flag) => [flag, { type: "string" as const }]));
  const { values } = parseArgs({ args: [...args], options, strict: true });
  const missing = ["base", "head", ...command.required].some((flag) => values[flag] === undefined);
  if (missing) throw new Error(command.usage);
  return values;
}

function flag(argv: readonly string[], name: string): string {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? "" : (argv[index + 1] ?? "");
}

/**
 * Parses `fix-proof run|exec|judge` arguments and returns the line to print: one result line for run and judge, and
 * nothing for a successful exec, which writes its reports instead. Bad arguments and failures give a verdict error line.
 */
export async function runCli(argv: readonly string[], cwd: string, runner: Runner = run): Promise<string> {
  const fail = (error: unknown) => errorLine({ base: flag(argv, "base"), head: flag(argv, "head") }, messageOf(error));
  const [name = "", ...args] = argv;
  const command = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined;
  if (command === undefined) return fail(new Error(USAGE));
  try {
    return await command.act(readValues(args, command), cwd, runner);
  } catch (error) {
    return fail(error);
  }
}

/** Prints runCli's line for a bin entry. Always exit 0: the verdict lives in the printed line, so a failing check never stands in for one. */
export async function main(argv: readonly string[]): Promise<void> {
  const line = await runCli(argv, process.cwd());
  if (line !== "") process.stdout.write(`${line}\n`);
  process.exitCode = 0;
}
