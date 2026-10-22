import type { HookResult } from "../hook.js";
import { cpuStopwatch } from "./cpu-budget.js";

/** Runs the hook on one event, usually a closure over `handle` with a test port. */
export type HookRun = (input: string) => Promise<Pick<HookResult, "stdout">>;

interface ParseBudgetOptions {
  /** Thread CPU the run may spend. */
  ms?: number;
  /** The hook must deny the command. */
  mustDeny?: boolean;
}

interface ParseBudgetResult {
  cpuMs: number;
  denied: boolean;
  /** Empty only when the run stayed under budget and, if asked, denied. */
  problems: string[];
}

/**
 * A test bound, not a product one: the hook's own limit is its 3.5 s deadline. CI thread CPU runs four to five times
 * local, and the slowest sweep row reached 259.4 ms there, so this allows about twice that (TP-3898).
 */
const DEFAULT_PARSE_BUDGET_MS = 500;

const DENY_MARK = '"permissionDecision":"deny"';

/** A PreToolUse Bash event as Claude Code sends it. */
export function bashEvent(command: string, cwd = "/home/you/app"): string {
  return JSON.stringify({ tool_name: "Bash", session_id: "s", tool_use_id: "t", cwd, tool_input: { command } });
}

/**
 * Times the hook in this thread's CPU, not the wall clock: in a full run the worker shares the runner's cores with
 * other test files, and the time it waits for one says nothing about the work the hook does. Call it inside a
 * `cpuBudgetIt` test.
 */
export async function withinParseBudget(run: HookRun, command: string, opts: ParseBudgetOptions = {}): Promise<ParseBudgetResult> {
  const ms = opts.ms ?? DEFAULT_PARSE_BUDGET_MS;
  const elapsed = cpuStopwatch();
  const { stdout } = await run(bashEvent(command));
  const cpuMs = elapsed();
  const denied = stdout.includes(DENY_MARK);
  const problems: string[] = [];
  if (cpuMs >= ms) problems.push(`took ${cpuMs.toFixed(1)} ms of CPU, budget ${ms} ms`);
  if (opts.mustDeny && !denied) problems.push("not denied");
  return { cpuMs, denied, problems };
}
