import type { HookResult } from "../hook.js";

/** Runs the hook on one event, usually a closure over `handle` with a test port. */
export type HookRun = (input: string) => Promise<Pick<HookResult, "stdout">>;

export interface ParseBudgetOptions {
  /** Thread CPU the run may spend. */
  ms?: number;
  /** The hook must deny the command. */
  mustDeny?: boolean;
}

export interface ParseBudgetResult {
  cpuMs: number;
  denied: boolean;
  /** Empty only when the run stayed under budget and, if asked, denied. */
  problems: string[];
}

/** Well under Claude Code's 5 s hook timeout, past which a command runs unchecked. */
export const DEFAULT_PARSE_BUDGET_MS = 250;

const DENY_MARK = '"permissionDecision":"deny"';

/** A PreToolUse Bash event as Claude Code sends it. */
export function bashEvent(command: string, cwd = "/home/you/app"): string {
  return JSON.stringify({ tool_name: "Bash", session_id: "s", tool_use_id: "t", cwd, tool_input: { command } });
}

/**
 * Times the hook in this thread's CPU, not the wall clock: in a full run the worker shares the runner's cores with
 * other test files, and the time it waits for one says nothing about the work the hook does.
 */
export async function withinParseBudget(run: HookRun, command: string, opts: ParseBudgetOptions = {}): Promise<ParseBudgetResult> {
  const ms = opts.ms ?? DEFAULT_PARSE_BUDGET_MS;
  const start = process.threadCpuUsage();
  const { stdout } = await run(bashEvent(command));
  const { user, system } = process.threadCpuUsage(start);
  const cpuMs = (user + system) / 1000;
  const denied = stdout.includes(DENY_MARK);
  const problems: string[] = [];
  if (cpuMs >= ms) problems.push(`took ${cpuMs.toFixed(1)} ms of CPU, budget ${ms} ms`);
  if (opts.mustDeny && !denied) problems.push("not denied");
  return { cpuMs, denied, problems };
}
