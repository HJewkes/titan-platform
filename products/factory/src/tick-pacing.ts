import { execGh, type GhExec } from "@titan-design/github";
import { cachedProbe } from "./cached-probe.js";

const NORMAL_TICK_MS = 60_000;
const SLOW_TICK_MS = 5 * 60_000;
/** Calls left, under which the snapshot tick slows. */
const LOW_RATE_REMAINING = 1_000;
const RATE_PROBE_TTL_MS = 60_000;
const RATE_PROBE_TIMEOUT_MS = 10_000;

/** What `/health` reports under `snapshotTick`. */
interface TickStatus {
  tickMs: number;
  slowed: boolean;
  /** Core calls left at the last `rate_limit` read; null before the first read lands or when it failed. */
  remaining: number | null;
}

/** How often the per-repo PR snapshot re-reads its open list: slower while the GitHub rate limit runs low. */
export interface TickPacing {
  tickMs(): number;
  status(): TickStatus;
}

interface TickPacingOptions {
  exec?: GhExec;
  now?: () => number;
}

/** A `rate_limit` read that fails or cannot be parsed keeps the normal tick: the snapshot's 304s already cost nothing. */
export function tickPacing({ exec = execGh, now = Date.now }: TickPacingOptions = {}): TickPacing {
  const probe = cachedProbe<number | null, null>(() => readRemaining(exec), { now, ttlMs: RATE_PROBE_TTL_MS, pending: null });
  const status = (): TickStatus => {
    const remaining = probe.status();
    const slowed = remaining !== null && remaining < LOW_RATE_REMAINING;
    return { tickMs: slowed ? SLOW_TICK_MS : NORMAL_TICK_MS, slowed, remaining };
  };
  return { tickMs: () => status().tickMs, status };
}

async function readRemaining(exec: GhExec): Promise<number | null> {
  try {
    const { code, stdout } = await exec(["api", "rate_limit"], undefined, { timeoutMs: RATE_PROBE_TIMEOUT_MS });
    if (code !== 0) return null;
    const remaining = (JSON.parse(stdout) as { resources?: { core?: { remaining?: unknown } } }).resources?.core?.remaining;
    return typeof remaining === "number" ? remaining : null;
  } catch {
    return null;
  }
}
