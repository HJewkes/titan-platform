/** Below this many remaining core calls, every call waits its share of the time left until reset. */
export const RATE_FLOOR = 500;

/** One budget per GitHub login: every wire that shares it paces against the same remaining count. */
export interface RateBudget {
  /** Resolves when a call may go out. */
  acquire(): Promise<void>;
  /** Reads `x-ratelimit-*` from a response's lower-cased headers; other resources are ignored. */
  observe(headers: ReadonlyMap<string, string>): void;
  readonly remaining: number | null;
}

export interface RateBudgetOptions {
  floor?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export function rateBudget(options: RateBudgetOptions = {}): RateBudget {
  const floor = options.floor ?? RATE_FLOOR;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let remaining: number | null = null;
  let resetAtMs = 0;
  return {
    get remaining() {
      return remaining;
    },
    observe(headers) {
      const observed = rateHeaders(headers);
      if (observed) ({ remaining, resetAtMs } = observed);
    },
    async acquire() {
      const wait = backoffMs(remaining, resetAtMs, floor, now());
      if (wait > 0) await sleep(wait);
      if (remaining !== null) remaining = now() >= resetAtMs ? null : Math.max(0, remaining - 1);
    },
  };
}

/** Spreads the calls left over the time left, so a low budget slows callers instead of exhausting them. */
export function backoffMs(remaining: number | null, resetAtMs: number, floor: number, nowMs: number): number {
  if (remaining === null || remaining >= floor || nowMs >= resetAtMs) return 0;
  return Math.ceil((resetAtMs - nowMs) / Math.max(remaining, 1));
}

function rateHeaders(headers: ReadonlyMap<string, string>): { remaining: number; resetAtMs: number } | null {
  const resource = headers.get("x-ratelimit-resource");
  if (resource !== undefined && resource !== "core") return null;
  const remaining = Number(headers.get("x-ratelimit-remaining"));
  const reset = Number(headers.get("x-ratelimit-reset"));
  if (!headers.has("x-ratelimit-remaining") || !Number.isFinite(remaining) || !Number.isFinite(reset)) return null;
  return { remaining, resetAtMs: reset * 1000 };
}

/** The default for every `ghCliWire` in this process, because GitHub counts calls per login, not per wire. */
export const sharedRateBudget: RateBudget = rateBudget();
