import { realpathSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import { generateRuffAuditConfig } from "../generators/ruff-audit.js";
import { runRuff } from "./ruff-runner.js";
import type { RunnerOptions, RunnerResult } from "./types.js";

/** Runs the pinned audit rule set; diagnostics carry paths relative to `cwd`, since ruff reports absolute ones. */
export async function runRuffAudit(files: string[], options?: Omit<RunnerOptions, "fix">): Promise<RunnerResult> {
  const result = await runRuff(generateRuffAuditConfig(), files, options);
  const root = realpathSync(options?.cwd ?? process.cwd());
  const diagnostics = result.diagnostics.map((d) => ({ ...d, file: relativeTo(root, d.file) }));
  return { ...result, diagnostics };
}

function relativeTo(root: string, file: string): string {
  return isAbsolute(file) ? relative(root, file) : file;
}
