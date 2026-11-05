import type { HookResult } from "../hook.js";
import { BENCH, cpuStopwatch } from "./cpu-budget.js";
import { countWork } from "./work-count.js";

/** Runs the hook on one event, usually a closure over `handle` with a test port. */
export type HookRun = (input: string) => Promise<Pick<HookResult, "stdout">>;

interface ParseBudgetOptions {
  /** Thread CPU the run may spend, checked only under the bench. */
  ms?: number;
  /** Counted calls the run may make per byte of the command. */
  workPerByte?: number;
  bench?: boolean;
  /** The hook must deny the command. */
  mustDeny?: boolean;
}

interface ParseBudgetResult {
  cpuMs: number;
  work: number;
  denied: boolean;
  /** Empty only when the run stayed under budget and, if asked, denied. */
  problems: string[];
}

/**
 * A test bound, not a product one: the hook's own limit is its 3.5 s deadline. CI thread CPU runs four to five times
 * local, and the slowest sweep row reached 259.4 ms there, so this allows about twice that (TP-3898).
 */
const DEFAULT_PARSE_BUDGET_MS = 500;
/**
 * The work a run may do per byte of its command, in characters read. The heaviest sweep rows, a sentinel inside sh-c
 * padded to 8 KiB, read 808 a byte, since each of the eight levels is read again unquoted; this allows about twice
 * that. A walk that went exponential in the nesting would read 2^8 times the line.
 */
const DEFAULT_WORK_PER_BYTE = 1_600;
/** Work any event costs beyond its command: parsing the event and classifying a short sentinel read up to 7 300. */
const EVENT_WORK = 15_000;

const DENY_MARK = '"permissionDecision":"deny"';

/** A PreToolUse Bash event as Claude Code sends it. */
export function bashEvent(command: string, cwd = "/home/you/app"): string {
  return JSON.stringify({ tool_name: "Bash", session_id: "s", tool_use_id: "t", cwd, tool_input: { command } });
}

/**
 * Counts the hook's work, which fails the test past the run's work cap, and under the bench also times it in this
 * thread's CPU, not the wall clock: in a full run the worker shares the runner's cores with other test files, and the
 * time it waits for one says nothing about the work the hook does. Call it inside a `cpuBudgetIt` test.
 */
export async function withinParseBudget(run: HookRun, command: string, opts: ParseBudgetOptions = {}): Promise<ParseBudgetResult> {
  const ms = opts.ms ?? DEFAULT_PARSE_BUDGET_MS;
  const cap = EVENT_WORK + Math.ceil(Buffer.byteLength(command) * (opts.workPerByte ?? DEFAULT_WORK_PER_BYTE));
  const event = bashEvent(command);
  let stdout = "";
  const elapsed = cpuStopwatch();
  const work = await countWork(async () => ({ stdout } = await run(event)), cap);
  const cpuMs = elapsed();
  const denied = stdout.includes(DENY_MARK);
  const problems: string[] = [];
  if ((opts.bench ?? BENCH) && cpuMs >= ms) problems.push(`took ${cpuMs.toFixed(1)} ms of CPU, budget ${ms} ms`);
  if (opts.mustDeny && !denied) problems.push("not denied");
  return { cpuMs, work, denied, problems };
}
