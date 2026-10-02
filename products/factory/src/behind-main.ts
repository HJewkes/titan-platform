import { execGh, type GhExec } from "@titan-design/github";
import { UNKNOWN_BUILD_SHA } from "./build-info.js";
import { redactForEvidence } from "./redact.js";

export const BEHIND_MAIN_TTL_MS = 5 * 60_000;
export const BEHIND_MAIN_TIMEOUT_MS = 10_000;
const REPO = "HJewkes/titan-platform";
const PENDING = "checking";
const DIRTY_SUFFIX = "-dirty";

export interface BehindMainOptions {
  sha: string;
  exec?: GhExec;
  now?: () => number;
  ttlMs?: number;
  timeoutMs?: number;
}

export interface BehindMain {
  /** Commits main is ahead of the build, `checking` before the first probe lands, or a redacted error; never waits on gh. */
  status(): number | string;
  /** Probe now unless one is in flight or the last result is still fresh. */
  refresh(): Promise<void>;
}

/** Same background-refresh shape as `githubHealth`, caching `gh compare <sha>...main` for five minutes. */
export function behindMain(options: BehindMainOptions): BehindMain {
  const { sha, exec = execGh, now = Date.now, ttlMs = BEHIND_MAIN_TTL_MS, timeoutMs = BEHIND_MAIN_TIMEOUT_MS } = options;
  if (sha === UNKNOWN_BUILD_SHA) return { status: () => UNKNOWN_BUILD_SHA, refresh: async () => undefined };
  let last: { value: number | string; at: number } | undefined;
  let inFlight: Promise<void> | null = null;
  const refresh = (): Promise<void> => {
    if (inFlight || (last && now() - last.at < ttlMs)) return inFlight ?? Promise.resolve();
    inFlight = probe(exec, sha.replace(DIRTY_SUFFIX, ""), timeoutMs)
      .then((value) => void (last = { value, at: now() }))
      .finally(() => (inFlight = null));
    return inFlight;
  };
  return {
    status: () => {
      void refresh();
      return last?.value ?? PENDING;
    },
    refresh,
  };
}

async function probe(exec: GhExec, sha: string, timeoutMs: number): Promise<number | string> {
  const args = ["api", `repos/${REPO}/compare/${sha}...main`, "--jq", ".ahead_by"];
  try {
    const { code, stdout, stderr } = await exec(args, undefined, { timeoutMs });
    if (code !== 0) return redactForEvidence(`gh compare failed (${code}): ${stderr.trim() || stdout.trim()}`);
    const ahead = Number(stdout.trim());
    return Number.isInteger(ahead) && ahead >= 0 ? ahead : "gh compare returned no commit count";
  } catch (err) {
    return redactForEvidence(`gh compare failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
