import { generateRuffAuditConfig } from "../generators/ruff-audit.js";
import { runPythonTool } from "./python-tool.js";
import type { AuditOptions, PythonToolSpec } from "./python-tool.js";
import { parseRuffOutput, ruffCheckArgs, withRuffConfig } from "./ruff-runner.js";
import type { RunnerResult } from "./types.js";

const RUFF: PythonToolSpec = { tool: "ruff", command: "ruff", install: "pip install ruff", expect: {} };

/** Runs the pinned audit rule set; diagnostics and failures carry paths relative to `cwd`, since ruff reports absolute ones. */
export async function runRuffAudit(files: string[], options?: AuditOptions): Promise<RunnerResult> {
  return withRuffConfig(generateRuffAuditConfig(), (configPath) =>
    runPythonTool(RUFF, ruffCheckArgs(configPath, files), options, parseRuffOutput),
  );
}
