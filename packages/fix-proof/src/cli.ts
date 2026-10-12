import { parseArgs } from "node:util";
import { errorLine, run, type RunOptions } from "./run.js";

export const USAGE = "usage: fix-proof run --base <mergeBase> --head <sha> [--repo <dir>] [--budget-ms <n>]";

const OPTIONS = {
  base: { type: "string" },
  head: { type: "string" },
  repo: { type: "string" },
  "budget-ms": { type: "string" },
} as const;

function readOptions(argv: readonly string[], cwd: string): RunOptions {
  const { positionals, values } = parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true, strict: true });
  if (positionals.length !== 1 || positionals[0] !== "run") throw new Error(USAGE);
  if (values.base === undefined || values.head === undefined) throw new Error(USAGE);
  const options: RunOptions = { repo: values.repo ?? cwd, base: values.base, head: values.head };
  if (values["budget-ms"] !== undefined) {
    const budgetMs = Number(values["budget-ms"]);
    if (!Number.isSafeInteger(budgetMs) || budgetMs <= 0) throw new Error("--budget-ms must be a positive integer");
    options.budgetMs = budgetMs;
  }
  return options;
}

function flag(argv: readonly string[], name: string): string {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? "" : (argv[index + 1] ?? "");
}

/** Parses `fix-proof run` arguments and returns the one result line to print; bad arguments give a verdict error line too. */
export async function runCli(argv: readonly string[], cwd: string, runner: typeof run = run): Promise<string> {
  const fail = (error: unknown) =>
    errorLine({ base: flag(argv, "base"), head: flag(argv, "head") }, error instanceof Error ? error.message : String(error));
  let options: RunOptions;
  try {
    options = readOptions(argv, cwd);
  } catch (error) {
    return fail(error);
  }
  return runner(options).catch(fail);
}
