import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Command } from "commander";
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

function validateCommand(): Command {
  return new Command("validate")
    .description("Strict-parse spec files, re-read their prompts and print each content hash")
    .argument("<files...>", "unit, variant, case, suite or scorecard JSON files")
    .action(async (files: string[]) => {
      let failed = false;
      for (const file of files) {
        const root = unitRootOf(file);
        const result = await validateSpec(JSON.parse(readFileSync(file, "utf8")), (path) => readFile(join(root, path)));
        console.log(`${result.hash}  ${result.schema}  ${file}${result.stalePrompts ? "  STALE prompt digest" : ""}`);
        failed ||= result.stalePrompts;
      }
      if (failed) process.exitCode = 1;
    });
}

export function buildProgram(): Command {
  return new Command("titan-evals")
    .description("Eval registry for units of work: specs, content hashes, and (in later slices) trials and scorecards")
    .addCommand(validateCommand())
    .showHelpAfterError();
}

export async function runCli(argv: string[]): Promise<number> {
  const program = buildProgram();
  if (argv.length === 0) {
    program.outputHelp();
    return 0;
  }
  await program.parseAsync(argv, { from: "user" });
  return Number(process.exitCode ?? 0);
}
