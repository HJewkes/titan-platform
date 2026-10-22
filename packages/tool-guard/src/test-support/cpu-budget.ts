import { expect, it } from "vitest";

/**
 * Whether this run asserts CPU and wall budgets: `pnpm --filter @titan-design/tool-guard bench` sets it. A budget in
 * milliseconds holds only on a machine with cores to spare. Under `pnpm test` the same tests count work instead, which
 * no load changes (TP-4047).
 */
export const BENCH = process.env.TOOL_GUARD_BENCH === "1";

/**
 * Wall-clock time a budget test may take per millisecond of its CPU budget. A loaded CI runner stretches wall time far
 * more than thread CPU: on the red run behind TP-3876 two checks that take under 3.1 s on a green run passed 5 s, a
 * stretch of at least 1.7 times. Since a healthy test spends well under its budget, twelve leaves room for several times
 * that (TP-3877).
 */
const WALL_PER_CPU_MS = 12;
/** The suite's own `testTimeout`, which a small budget must not shorten: under `pnpm test` the timeout only catches a hang. */
const SUITE_TIMEOUT_MS = 30_000;

/** The wall-clock timeout of a test whose thread may spend `cpuMs` of CPU. */
export const wallTimeoutMs = (cpuMs: number): number => Math.max(SUITE_TIMEOUT_MS, WALL_PER_CPU_MS * cpuMs);

interface Running {
  budgetMs: number;
  start: NodeJS.CpuUsage;
  bench: boolean;
}

let running: Running | null = null;

const msSince = (start: NodeJS.CpuUsage): number => {
  const { user, system } = process.threadCpuUsage(start);
  return (user + system) / 1000;
};

function current(): Running {
  if (running === null) throw new Error("time CPU only inside cpuBudgetIt, which sets the test's wall timeout from its budget");
  return running;
}

/** Starts a stopwatch on this thread's CPU; calling the result gives the milliseconds spent since. */
export function cpuStopwatch(): () => number {
  current();
  const start = process.threadCpuUsage();
  return () => msSince(start);
}

/**
 * Under the bench, fails the running test once its body has spent its CPU budget. A loop that calls this between runs
 * fails on an assertion within one run of the budget, long before the wall timeout, however slow the code under test
 * became. Under `pnpm test` it checks nothing: CI thread CPU runs four times local and more under load (TP-4040).
 */
export function expectWithinCpuBudget(): void {
  const { budgetMs, start, bench } = current();
  if (bench) expect(msSince(start), `thread CPU of a test with a ${budgetMs} ms budget`).toBeLessThan(budgetMs);
}

/**
 * Under the bench, asserts `body` ends within `ms` of wall time, for work done in a child process, which this thread's
 * CPU cannot see. Under `pnpm test` it only runs `body`.
 */
export async function withinWallBudget<T>(ms: number, body: () => T | Promise<T>, bench = BENCH): Promise<T> {
  const start = performance.now();
  const result = await body();
  if (bench) expect(performance.now() - start, `wall time of a step with a ${ms} ms budget`).toBeLessThan(ms);
  return result;
}

/** Runs `body` as a budget test does: under the bench it fails on an assertion if the body spends `budgetMs` of this thread's CPU. */
export async function withinCpuBudget(budgetMs: number, body: () => unknown, bench = BENCH): Promise<void> {
  const mine: Running = { budgetMs, start: process.threadCpuUsage(), bench };
  running = mine;
  try {
    await body();
    expectWithinCpuBudget();
  } finally {
    // A body that outlived its wall timeout finishes during a later test, whose budget it must leave in place.
    if (running === mine) running = null;
  }
}

/**
 * A test that asserts CPU time or a time ratio. Under the bench its body may spend `cpuMs` of this thread's CPU, checked
 * when it ends, and its wall-clock timeout is `wallTimeoutMs(cpuMs)`, so load on the runner cannot time it out before
 * the CPU check fails. The fix-proof judge's `--testTimeout` does not override it, since a per-test timeout wins.
 */
export function cpuBudgetIt(name: string, cpuMs: number, body: () => unknown): void {
  it(name, () => withinCpuBudget(cpuMs, body), wallTimeoutMs(cpuMs));
}

/**
 * `it.each` for budget tests: each row's body may spend `cpuMs` of CPU. The [unknown] member of T makes TypeScript infer
 * each row as a tuple, as vitest's own it.each does.
 */
cpuBudgetIt.each = <T extends readonly unknown[] | [unknown]>(rows: readonly T[]) => {
  const each = it.each(rows);
  // The body vitest's each would take: its last overload is (name, options, fn).
  type Body = Parameters<typeof each>[2];
  return (name: string, cpuMs: number, body: Body): void => {
    each(name, (...args) => withinCpuBudget(cpuMs, () => body(...args)), wallTimeoutMs(cpuMs));
  };
};
