import { resolve } from "node:path";
import { Command, CommanderError, InvalidArgumentError, Option } from "commander";
import { runOracle } from "./implement/oracle.js";

interface OracleFlags {
  track: "i";
  cases: string;
  prepared: string;
  repoDir: string;
  out: string;
  limit: number;
  seed: string;
}

const positiveInt = (value: string): number => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new InvalidArgumentError("expected a positive integer");
  return parsed;
};

/** Adds `oracle`: no model, the I scorer over each case's untouched base (must fail) and its accepted diff (must solve). */
export function registerOracle(program: Command, onResult: (code: number) => void): Command {
  const command = new Command("oracle")
    .description("Score each queued case's base and base + accepted diff through the I scorer; rows go to <out>/oracle.jsonl")
    .addOption(new Option("--track <track>", "only i has an oracle").choices(["i"]).makeOptionMandatory())
    .requiredOption("--cases <dir>", "the I case dir: cases.jsonl and hidden/<id>")
    .requiredOption("--prepared <dir>", "the prepared bases, one <case id> dir each")
    .option("--repo-dir <dir>", "a clone holding the cases' base and merge commits", process.cwd())
    .requiredOption("--out <dir>", "where oracle.jsonl and the per-case scratch go")
    .option("--limit <n>", "the first n cases of the stratified queue", positiveInt, 10)
    .option("--seed <text>", "seeds the queue order", "bench-2026-11")
    .exitOverride()
    .action(async (flags: OracleFlags) => {
      try {
        const dirs = { casesDir: resolve(flags.cases), preparedRoot: resolve(flags.prepared), repoDir: resolve(flags.repoDir), outDir: resolve(flags.out) };
        onResult((await runOracle({ ...dirs, limit: flags.limit, seed: flags.seed, path: process.env.PATH ?? "", log: (line) => console.error(line) })) ? 0 : 1);
      } catch (error) {
        if (error instanceof CommanderError) throw error;
        console.error(`bench oracle: ${error instanceof Error ? error.message : String(error)}`);
        onResult(1);
      }
    });
  return program.addCommand(command);
}
