import { execGh, type GhExec } from "@titan-design/github";
import { redactForEvidence } from "./redact.js";

export const GITHUB_PROBE_TTL_MS = 60_000;
export const GITHUB_PROBE_TIMEOUT_MS = 10_000;
const PENDING = "checking";

export interface GithubHealthOptions {
  exec?: GhExec;
  now?: () => number;
  ttlMs?: number;
  timeoutMs?: number;
}

export interface GithubHealth {
  /** `ok`, the redacted gh error, or `checking` before the first probe lands; never waits on gh. */
  status(): string;
  /** Probe now unless one is in flight or the last result is still fresh. */
  refresh(): Promise<void>;
}

/** Health is synchronous, so it reports the last `gh api rate_limit` result and refreshes it in the background at most once per ttl. */
export function githubHealth(options: GithubHealthOptions = {}): GithubHealth {
  const { exec = execGh, now = Date.now, ttlMs = GITHUB_PROBE_TTL_MS, timeoutMs = GITHUB_PROBE_TIMEOUT_MS } = options;
  let last: { value: string; at: number } | undefined;
  let inFlight: Promise<void> | null = null;
  const refresh = (): Promise<void> => {
    if (inFlight || (last && now() - last.at < ttlMs)) return inFlight ?? Promise.resolve();
    inFlight = probe(exec, timeoutMs)
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

async function probe(exec: GhExec, timeoutMs: number): Promise<string> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve(`gh api rate_limit timed out after ${timeoutMs} ms`), timeoutMs);
  });
  try {
    const result = await Promise.race([exec(["api", "rate_limit"]).then(describe, (err: unknown) => describeError(err)), timedOut]);
    return result;
  } finally {
    clearTimeout(timer);
  }
}

function describe({ code, stdout, stderr }: { code: number; stdout: string; stderr: string }): string {
  if (code === 0) return "ok";
  return redactForEvidence(`gh api rate_limit failed (${code}): ${stderr.trim() || stdout.trim()}`);
}

function describeError(err: unknown): string {
  return redactForEvidence(`gh api rate_limit failed: ${err instanceof Error ? err.message : String(err)}`);
}
