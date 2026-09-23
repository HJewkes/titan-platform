import { generateRuffAuditConfig } from "../generators/ruff-audit.js";
import { auditRoot, relativeTo } from "./paths.js";
import { runRuff } from "./ruff-runner.js";
import type { RunnerOptions, RunnerResult } from "./types.js";

/** Runs the pinned audit rule set; diagnostics carry paths relative to `cwd`, since ruff reports absolute ones. */
export async function runRuffAudit(files: string[], options?: Omit<RunnerOptions, "fix">): Promise<RunnerResult> {
  const result = await runRuff(generateRuffAuditConfig(), files, options);
  const root = auditRoot(options?.cwd);
  const diagnostics = result.diagnostics.map((d) => ({ ...d, file: relativeTo(root, d.file) }));
  return { ...result, diagnostics };
}
