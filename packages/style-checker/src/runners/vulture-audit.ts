import { runPythonTool, unrecognisedStderr } from "./python-tool.js";
import type { AuditOptions, ParsedOutput, PythonToolSpec, ToolOutput } from "./python-tool.js";
import type { CheckDiagnostic, ToolFailure } from "../orchestrator/types.js";
import type { RunnerResult } from "./types.js";

// vulture exits 1 on invalid input (a syntax error) and 3 when it found dead code; both still carry findings.
const VULTURE: PythonToolSpec = {
  tool: "vulture",
  command: "vulture",
  install: "pip install vulture",
  expect: { successCodes: new Set([0, 1, 3]), allowEmptyStdout: true },
};

const FINDING = /^(.+?):(\d+): (.+) \((\d+)% confidence(?:, \d+ lines?)?\)$/;
const INVALID_INPUT = /^(.+?):(\d+): (.+)$/;
const NOT_FOUND = /^Error: (.+) could not be found\.$/;

export interface VultureOptions extends AuditOptions {
  /** vulture's --min-confidence; 60 keeps its uncertain unused-code guesses, 100 keeps only unreachable code. */
  minConfidence?: number;
}

/** Rule suffix from vulture's wording: "unused function 'x'" is unused-function; every other finding is unreachable code. */
export function vultureKind(text: string): string {
  const unused = /^unused (\w+)/.exec(text);
  return unused ? `unused-${unused[1]}` : "unreachable";
}

function toDiagnostic(m: RegExpExecArray): CheckDiagnostic {
  const [, file, line, text, confidence] = m as unknown as [string, string, string, string, string];
  return {
    file,
    line: Number(line),
    column: 1,
    severity: "warn",
    message: `${text} (${confidence}% confidence)`,
    category: "dead-code",
    rule: `vulture/${vultureKind(text)}`,
    fixable: false,
  };
}

function parseStdout(stdout: string): CheckDiagnostic[] {
  return stdout.split("\n").filter((l) => l.trim()).map((line) => {
    const m = FINDING.exec(line);
    if (!m) throw new Error(`Unrecognised vulture line: ${line}`);
    return toDiagnostic(m);
  });
}

function parseStderr(stderr: string): ToolFailure[] {
  const failures: ToolFailure[] = [];
  const unknown: string[] = [];
  for (const line of stderr.split("\n").filter((l) => l.trim())) {
    const missing = NOT_FOUND.exec(line);
    const invalid = INVALID_INPUT.exec(line);
    if (missing) failures.push({ tool: "vulture", kind: "file-not-checked", file: missing[1]!, message: "could not be found" });
    else if (invalid) failures.push({ tool: "vulture", kind: "file-not-checked", file: invalid[1]!, message: invalid[3]! });
    else unknown.push(line);
  }
  return [...failures, ...unrecognisedStderr("vulture", unknown)];
}

export function parseVultureOutput({ stdout, stderr }: ToolOutput): ParsedOutput {
  return { diagnostics: parseStdout(stdout), failures: parseStderr(stderr) };
}

/** Dead-code candidates from vulture at `minConfidence` (default 60); rule ids are vulture/<kind>. */
export function runVultureAudit(files: string[], options?: VultureOptions): Promise<RunnerResult> {
  const args = ["--min-confidence", String(options?.minConfidence ?? 60), ...files];
  return runPythonTool(VULTURE, args, options, parseVultureOutput);
}
