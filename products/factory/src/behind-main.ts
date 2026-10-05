import { execGh, type GhExec } from "@titan-design/github";
import { DIRTY_SUFFIX, FACTORY_REPO, PROBE_PENDING, UNKNOWN_BUILD_SHA } from "./build-info.js";
import { cachedProbe, type CachedProbe } from "./cached-probe.js";
import { redactForEvidence } from "./redact.js";

export const BEHIND_MAIN_TTL_MS = 5 * 60_000;
export const BEHIND_MAIN_TIMEOUT_MS = 10_000;

export interface BehindMainOptions {
  sha: string;
  /** `owner/name` to compare against; defaults to `FACTORY_REPO`, and an undefined repo reports `unknown`. */
  repo?: string | undefined;
  exec?: GhExec;
  now?: () => number;
  ttlMs?: number;
  timeoutMs?: number;
}

/** Commits main is ahead of the build, `checking` before the first probe lands, or a redacted error; never waits on gh. */
export type BehindMain = CachedProbe<number | string, string>;

/** Caches `gh compare <sha>...main` for five minutes. */
export function behindMain(options: BehindMainOptions): BehindMain {
  const { sha, exec = execGh, now = Date.now, ttlMs = BEHIND_MAIN_TTL_MS, timeoutMs = BEHIND_MAIN_TIMEOUT_MS } = options;
  const repo = "repo" in options ? options.repo : FACTORY_REPO;
  if (sha === UNKNOWN_BUILD_SHA || repo === undefined) return { status: () => UNKNOWN_BUILD_SHA, refresh: async () => undefined };
  const cleanSha = sha.replace(DIRTY_SUFFIX, "");
  return cachedProbe(() => probe(exec, repo, cleanSha, timeoutMs), { now, ttlMs, pending: PROBE_PENDING });
}

async function probe(exec: GhExec, repo: string, sha: string, timeoutMs: number): Promise<number | string> {
  const args = ["api", `repos/${repo}/compare/${sha}...main`, "--jq", ".ahead_by"];
  try {
    const { code, stdout, stderr } = await exec(args, undefined, { timeoutMs });
    if (code !== 0) return redactForEvidence(`gh compare failed (${code}): ${stderr.trim() || stdout.trim()}`);
    const ahead = Number(stdout.trim());
    return Number.isInteger(ahead) && ahead >= 0 ? ahead : "gh compare returned no commit count";
  } catch (err) {
    return redactForEvidence(`gh compare failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
