import { execFileSync } from "node:child_process";
import type { Runner, RunResult } from "../dispatch/runner.js";

/*
 * The one subprocess the shadow dispatcher's reads may start: `gh api` GETs, for the upkeep cap's changed paths. Anything
 * else throws before a process starts, so this runner can neither write to GitHub nor launch an agent.
 */

const WRITE_FLAGS = new Set(["-X", "--method", "-f", "--raw-field", "-F", "--field", "--input"]);

const REPO_SLUG = /^[\w.-]+\/[\w.-]+$/;

const GH_TIMEOUT_MS = 60_000;

const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

function assertRead(bin: string, args: readonly string[]): void {
  if (bin !== "gh" || args[0] !== "api") throw new Error(`the shadow's gh reader runs only gh api, not ${bin} ${args[0] ?? ""}`);
  const write = args.find((arg) => WRITE_FLAGS.has(arg.split("=")[0]!));
  if (write !== undefined) throw new Error(`the shadow's gh reader makes no write, so it refuses ${write}`);
}

/**
 * `readPrFiles` passes its repo as the runner's `cwd` and leaves `{owner}/{repo}` for gh to fill; with no clone of the
 * repo at hand, a slug there names the repo through GH_REPO instead.
 */
export const ghApiRead: Runner = (bin, args, cwd) => {
  assertRead(bin, args);
  const slug = cwd !== undefined && REPO_SLUG.test(cwd);
  const env = slug ? { ...process.env, GH_REPO: cwd } : process.env;
  try {
    const stdout = execFileSync(bin, args, { encoding: "utf8", env, timeout: GH_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES, stdio: ["ignore", "pipe", "pipe"], ...(!slug && cwd !== undefined && { cwd }) });
    return { status: 0, stdout };
  } catch (error) {
    const failed = error as { status?: number | null; stdout?: string; stderr?: string; signal?: string | null };
    const result: RunResult = { status: failed.status ?? 1, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
    return failed.signal === "SIGTERM" ? { ...result, timedOut: true } : result;
  }
};
