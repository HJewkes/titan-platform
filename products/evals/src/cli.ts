import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Command, CommanderError } from "commander";
import { validateSpec } from "./validate.js";

/** Prompt paths are relative to the unit directory: the nearest ancestor holding unit.json. */
export function unitRootOf(specPath: string): string {
  let dir = dirname(resolve(specPath));
  while (!existsSync(join(dir, "unit.json"))) {
    const parent = dirname(dir);
    if (parent === dir) return dirname(resolve(specPath));
    dir = parent;
  }
  return dir;
}

const EXIT = { OK: 0, FAILURE: 1, USAGE: 2 } as const;

function validateCommand(onResult: (code: number) => void): Command {
  return new Command("validate")
    .description("Strict-parse spec files, re-read their prompts and print each content hash")
    .argument("<files...>", "unit, variant, case, suite or scorecard JSON files")
    .exitOverride()
    .action(async (files: string[]) => {
      let failed = false;
      for (const file of files) failed = !(await validateFile(file)) || failed;
      onResult(failed ? EXIT.FAILURE : EXIT.OK);
    });
}

/** Reports one file's result; a missing file, bad JSON or a schema error is reported, not thrown. */
async function validateFile(file: string): Promise<boolean> {
  try {
    const root = unitRootOf(file);
    const result = await validateSpec(JSON.parse(readFileSync(file, "utf8")), (path) => readFile(join(root, path)));
    console.log(`${result.hash}  ${result.schema}  ${file}${result.stalePrompts ? "  STALE prompt digest" : ""}`);
    return !result.stalePrompts;
  } catch (error) {
    console.error(`${file}: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

export function buildProgram(onResult: (code: number) => void = () => undefined): Command {
  return new Command("titan-evals")
    .description("Eval registry for units of work: specs, content hashes, and (in later slices) trials and scorecards")
    .addCommand(validateCommand(onResult))
    .exitOverride()
    .showHelpAfterError();
}

function exitCodeOf(error: unknown): number {
  if (!(error instanceof CommanderError)) throw error;
  return error.code === "commander.helpDisplayed" || error.code === "commander.version" ? EXIT.OK : EXIT.USAGE;
}

export async function runCli(argv: string[]): Promise<number> {
  let code: number = EXIT.OK;
  const program = buildProgram((result) => void (code = result));
  if (argv.length === 0) {
    program.outputHelp();
    return code;
  }
  try {
    await program.parseAsync(argv, { from: "user" });
  } catch (error) {
    return exitCodeOf(error);
  }
  return code;
}
