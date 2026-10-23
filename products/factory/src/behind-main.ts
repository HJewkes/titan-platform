import { execGh, type GhExec } from "@titan-design/github";
import { DIRTY_SUFFIX, FACTORY_REPO, PROBE_PENDING, UNKNOWN_BUILD_SHA } from "./build-info.js";
import { cachedProbe, type CachedProbe } from "./cached-probe.js";
import { reachesFactoryBuild } from "./deploy-closure.js";
import { redactForEvidence } from "./redact.js";

export const BEHIND_MAIN_TTL_MS = 5 * 60_000;
export const BEHIND_MAIN_TIMEOUT_MS = 10_000;
/** GitHub's compare lists at most this many files, so a list this long may hide one the build reads. */
export const COMPARE_FILE_CAP = 300;

export interface BehindMainOptions {
  sha: string;
  /** `owner/name` to compare against; defaults to `FACTORY_REPO`, and an undefined repo reports `unknown`. */
  repo?: string | undefined;
  exec?: GhExec;
  now?: () => number;
  ttlMs?: number;
  timeoutMs?: number;
  /** The factory build's package dirs; undefined, or absent, counts every commit behind. */
  closure?: () => readonly string[] | undefined;
}

/** Commits main is ahead of the build, `checking` before the first probe lands, or a redacted error; never waits on gh. */
export type BehindMain = CachedProbe<number | string, string>;

/** Caches `gh compare <sha>...main` for five minutes; reads 0 when no changed path reaches the factory build, as the deploy pacer skips it. */
export function behindMain(options: BehindMainOptions): BehindMain {
  const { sha, exec = execGh, now = Date.now, ttlMs = BEHIND_MAIN_TTL_MS, timeoutMs = BEHIND_MAIN_TIMEOUT_MS, closure = () => undefined } = options;
  const repo = "repo" in options ? options.repo : FACTORY_REPO;
  if (sha === UNKNOWN_BUILD_SHA || repo === undefined) return { status: () => UNKNOWN_BUILD_SHA, refresh: async () => undefined };
  const cleanSha = sha.replace(DIRTY_SUFFIX, "");
  return cachedProbe(() => probe(exec, repo, cleanSha, timeoutMs, closure), { now, ttlMs, pending: PROBE_PENDING });
}

async function probe(exec: GhExec, repo: string, sha: string, timeoutMs: number, closure: () => readonly string[] | undefined): Promise<number | string> {
  const args = ["api", `repos/${repo}/compare/${sha}...main`, "--jq", ".ahead_by, (.files // [] | length), .files[]?.filename"];
  try {
    const { code, stdout, stderr } = await exec(args, undefined, { timeoutMs });
    if (code !== 0) return redactForEvidence(`gh compare failed (${code}): ${stderr.trim() || stdout.trim()}`);
    const [first = "", count, ...files] = stdout.trim().split("\n");
    const ahead = Number(first);
    if (!Number.isInteger(ahead) || ahead < 0) return "gh compare returned no commit count";
    return ahead > 0 && skippable(count, files, closure()) ? 0 : ahead;
  } catch (err) {
    return redactForEvidence(`gh compare failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Only a complete file list can clear the commits; a missing or capped one counts them. */
function skippable(count: string | undefined, files: string[], closure: readonly string[] | undefined): boolean {
  const listed = Number(count);
  const complete = Number.isInteger(listed) && listed === files.length && listed < COMPARE_FILE_CAP;
  return complete && !reachesFactoryBuild(files, closure);
}
