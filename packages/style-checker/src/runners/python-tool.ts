import { parseOrFail, runAndClassify } from "./failures.js";
import type { RunExpectations, ToolRun } from "./failures.js";
import { auditRoot, relativeTo } from "./paths.js";
import type { CheckDiagnostic, ToolFailure, ToolName } from "../orchestrator/types.js";
import type { RunnerOptions, RunnerResult } from "./types.js";

/** How to invoke one audit tool and what to tell the user when it is not installed. */
export interface PythonToolSpec {
  tool: ToolName;
  command: string;
  install: string;
  installNote?: string;
  expect: RunExpectations;
}

export interface ToolOutput {
  stdout: string;
  stderr: string;
}

export interface ParsedOutput {
  diagnostics: CheckDiagnostic[];
  failures: ToolFailure[];
}

export type AuditOptions = Omit<RunnerOptions, "fix">;

export function emptyResult(exitCode: number | null, extra: Partial<RunnerResult> = {}): RunnerResult {
  return { diagnostics: [], exitCode, failures: [], skippedRules: [], warnings: [], ...extra };
}

export function missingToolWarning(spec: PythonToolSpec): string {
  const note = spec.installNote ? ` (${spec.installNote})` : "";
  return `${spec.tool} not found; install with \`${spec.install}\`${note}`;
}

function isMissingBinary(run: Extract<ToolRun, { ok: false }>): boolean {
  const { kind, message } = run.failure;
  if (kind === "spawn-failed" && message.includes("ENOENT")) return true;
  return run.exitCode === 127 || /command not found/i.test(message);
}

function relativise(root: string, parsed: ParsedOutput): ParsedOutput {
  return {
    diagnostics: parsed.diagnostics.map((d) => ({ ...d, file: relativeTo(root, d.file) })),
    failures: parsed.failures.map((f) => (f.file ? { ...f, file: relativeTo(root, f.file) } : f)),
  };
}

/** Runs one tool, maps an absent binary to a warning, and reports paths relative to `cwd`. */
export async function runPythonTool(
  spec: PythonToolSpec,
  args: string[],
  options: AuditOptions | undefined,
  parse: (output: ToolOutput) => ParsedOutput,
): Promise<RunnerResult> {
  const runOptions = { cwd: options?.cwd, timeout: options?.timeout };
  const run = await runAndClassify(spec.tool, spec.command, args, runOptions, spec.expect);
  if (!run.ok && isMissingBinary(run)) return emptyResult(null, { warnings: [missingToolWarning(spec)] });
  if (!run.ok) return emptyResult(run.exitCode, { failures: [run.failure] });
  const parsed = parseOrFail(spec.tool, () => parse(run));
  if (!parsed.ok) return emptyResult(run.exitCode, { failures: [parsed.failure] });
  return emptyResult(run.exitCode, relativise(auditRoot(options?.cwd), parsed.value));
}

/** Stderr lines a parser did not recognise, folded into one failure so a crash is never silent. */
export function unrecognisedStderr(tool: ToolName, lines: string[]): ToolFailure[] {
  if (lines.length === 0) return [];
  const message = lines.join("\n");
  return [{ tool, kind: "unparseable-output", message: message.length > 500 ? `${message.slice(0, 500)}…` : message }];
}
