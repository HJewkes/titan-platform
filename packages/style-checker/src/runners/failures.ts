import { runTool } from "./tool-runner.js";
import type { ToolRunResult } from "./tool-runner.js";
import type { ToolFailure, ToolName } from "../orchestrator/types.js";

// ESLint and ruff both document 0 (clean) and 1 (problems found) as successful runs.
const SUCCESS_EXIT_CODES = new Set([0, 1]);

export type ToolRun =
  | { ok: true; stdout: string; stderr: string; exitCode: number }
  | { ok: false; failure: ToolFailure; exitCode: number | null };

function excerpt(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > 500 ? `${trimmed.slice(0, 500)}…` : trimmed;
}

function withStderr(message: string, stderr: string): string {
  const detail = excerpt(stderr);
  return detail ? `${message}: ${detail}` : message;
}

export function classifyRun(tool: ToolName, run: ToolRunResult): ToolRun {
  const fail = (kind: ToolFailure["kind"], message: string): ToolRun => ({
    ok: false,
    failure: { tool, kind, message: withStderr(message, run.stderr) },
    exitCode: run.exitCode,
  });
  if (run.timedOut) return fail("timeout", `${tool} timed out and was killed`);
  if (run.exitCode === null) {
    return fail("signal", `${tool} was killed by ${run.signal ?? "a signal"}`);
  }
  if (!SUCCESS_EXIT_CODES.has(run.exitCode)) {
    return fail("exit-code", `${tool} exited with code ${run.exitCode}`);
  }
  if (!run.stdout.trim()) {
    return fail("unparseable-output", `${tool} exited ${run.exitCode} with no output`);
  }
  return { ok: true, stdout: run.stdout, stderr: run.stderr, exitCode: run.exitCode };
}

export async function runAndClassify(
  tool: ToolName,
  command: string,
  args: string[],
  options?: { cwd?: string; timeout?: number },
): Promise<ToolRun> {
  try {
    return classifyRun(tool, await runTool(command, args, options));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, failure: { tool, kind: "spawn-failed", message }, exitCode: null };
  }
}

export function parseOrFail<T>(
  tool: ToolName,
  parse: () => T,
): { ok: true; value: T } | { ok: false; failure: ToolFailure } {
  try {
    return { ok: true, value: parse() };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, failure: { tool, kind: "unparseable-output", message } };
  }
}
