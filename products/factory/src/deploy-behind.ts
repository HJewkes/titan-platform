import { DIRTY_SUFFIX, UNKNOWN_BUILD_SHA } from "./build-info.js";
import type { CommandResult } from "./service-control.js";
import { runCommand } from "./service-ports.js";

/** How far main has moved past the running build, or why git could not say. */
export type GitBehind = { merges: number; oldestAt: number | null } | { unknown: string };

/** Reads `runningSha` against origin/main in the deploy checkout. */
export type GitBehindProbe = (runningSha: string) => Promise<GitBehind>;

type Run = (file: string, args: readonly string[]) => Promise<CommandResult | undefined>;

/**
 * Counts the commits `origin/main` holds that the running build does not, and the commit time of the oldest. Unlike the
 * redeploy.log asks, this sees merges that never asked for a deploy, so a deployer that was never asked still reads behind.
 */
export function gitBehind(checkout: string, run: Run = runCommand): GitBehindProbe {
  return async (runningSha) => {
    if (runningSha === UNKNOWN_BUILD_SHA) return { unknown: "the running build's sha is unknown" };
    const base = runningSha.endsWith(DIRTY_SUFFIX) ? runningSha.slice(0, -DIRTY_SUFFIX.length) : runningSha;
    const result = await run("git", ["-C", checkout, "log", "--format=%ct", `${base}..origin/main`]);
    if (result === undefined) return { unknown: "git is not on PATH" };
    if (result.code !== 0) return { unknown: `git log ${base}..origin/main exited ${result.code}: ${result.stderr.trim().split("\n")[0] ?? ""}` };
    const times = result.stdout.split("\n").filter((line) => line !== "").map(Number);
    if (times.some((time) => !Number.isInteger(time))) return { unknown: "git log returned a commit time that is no number" };
    return { merges: times.length, oldestAt: times.length === 0 ? null : Math.min(...times) * 1000 };
  };
}
