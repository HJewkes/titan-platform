import { runPythonTool } from "./python-tool.js";
import type { AuditOptions, ParsedOutput, PythonToolSpec, ToolOutput } from "./python-tool.js";
import type { CheckDiagnostic, ToolFailure } from "../orchestrator/types.js";
import type { RunnerResult } from "./types.js";

const PYDOCLINT: PythonToolSpec = {
  tool: "pydoclint",
  command: "pydoclint",
  install: "pip install pydoclint",
  expect: { successCodes: new Set([0, 1]), allowEmptyStdout: true },
};

const VIOLATION = /^\s+(\d+): (DOC\d+): (.*)$/;
// pydoclint reports a file it cannot parse as a DOC002 violation at line 0.
const SYNTAX_ERROR = "DOC002";

export type DocstringStyle = "numpy" | "google" | "sphinx";

export interface PydoclintOptions extends AuditOptions {
  style?: DocstringStyle;
}

function toDiagnostic(file: string, m: RegExpExecArray): CheckDiagnostic {
  return {
    file,
    line: Math.max(1, Number(m[1])),
    column: 1,
    severity: "warn",
    message: m[3]!,
    category: "documentation",
    rule: `pydoclint/${m[2]}`,
    fixable: false,
  };
}

/** pydoclint prints each file's path unindented, then its violations indented beneath it, all on stderr. */
export function parsePydoclintOutput({ stdout, stderr }: ToolOutput): ParsedOutput {
  const parsed: ParsedOutput = { diagnostics: [], failures: [] };
  let file: string | undefined;
  for (const line of `${stdout}\n${stderr}`.split("\n").filter((l) => l.trim())) {
    const m = VIOLATION.exec(line);
    if (!m && /^\S/.test(line)) file = line.trim();
    else if (!m || !file) throw new Error(`Unrecognised pydoclint line: ${line}`);
    else if (m[2] === SYNTAX_ERROR) parsed.failures.push(notChecked(file, m[3]!));
    else parsed.diagnostics.push(toDiagnostic(file, m));
  }
  return parsed;
}

function notChecked(file: string, message: string): ToolFailure {
  return { tool: "pydoclint", kind: "file-not-checked", file, message };
}

/** Docstring-versus-signature drift from pydoclint in `style` (default numpy); rule ids are pydoclint/DOCnnn. */
export function runPydoclintAudit(files: string[], options?: PydoclintOptions): Promise<RunnerResult> {
  const args = ["--style", options?.style ?? "numpy", "--quiet", ...files];
  return runPythonTool(PYDOCLINT, args, options, parsePydoclintOutput);
}
