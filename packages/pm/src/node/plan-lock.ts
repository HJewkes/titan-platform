import { promises as fs } from "node:fs";
import path from "node:path";
import lockfile from "proper-lockfile";
import { PlanStoreError } from "./plan-errors.js";

/** A holder refreshes its lock every `PLAN_LOCK_STALE_MS / 2`; one older than this crashed. */
const PLAN_LOCK_STALE_MS = 10_000;
/** Longer than the stale window, so a waiter outlasts and reclaims a crashed holder's lock. */
const PLAN_LOCK_TIMEOUT_MS = 20_000;
const RETRY_MIN_MS = 10;

async function acquire(lockTarget: string, timeoutMs: number): Promise<() => Promise<void>> {
  try {
    return await lockfile.lock(lockTarget, {
      realpath: false,
      stale: PLAN_LOCK_STALE_MS,
      retries: { retries: Math.ceil(timeoutMs / RETRY_MIN_MS), factor: 1.2, minTimeout: RETRY_MIN_MS, maxTimeout: 100, randomize: true, maxRetryTime: timeoutMs },
    });
  } catch (err) {
    if (!(err instanceof Error && "code" in err && err.code === "ELOCKED")) throw err;
    throw new PlanStoreError("lock-timeout", `Gave up after ${timeoutMs}ms waiting for the lock on ${lockTarget}; another active-work process holds it. Retry later.`, { cause: err });
  }
}

/**
 * Serialises read-modify-write on one initiative's plan folder through `<initiative>/plan/.lock`, the lock every
 * plan writer takes, so a console-applied write and a CLI write never interleave. The initiative folder must exist.
 */
export async function withPlanLock<T>(activeRoot: string, initiative: string, fn: () => Promise<T>): Promise<T> {
  const stat = await fs.stat(path.join(activeRoot, initiative)).catch(() => null);
  if (!stat?.isDirectory()) throw new PlanStoreError("not-found", `Initiative not found: ${initiative}`);
  const planDir = path.join(activeRoot, initiative, "plan");
  await fs.mkdir(planDir, { recursive: true });
  const release = await acquire(path.join(planDir, ".lock"), PLAN_LOCK_TIMEOUT_MS);
  try {
    return await fn();
  } finally {
    await release();
  }
}
