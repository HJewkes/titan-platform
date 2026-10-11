/** Below this many remaining calls of a resource, every call waits its share of the time left until reset. */
export const RATE_FLOOR = 500;

/** One budget per GitHub login: every wire that shares it paces against the same remaining count. */
export interface RateBudget {
  /** Resolves when a call to `resource` may go out; GraphQL has its own quota, apart from core. */
  acquire(resource?: BudgetResource): Promise<void>;
  /** Reads `x-ratelimit-*` from a response's lower-cased headers; resources other than core and graphql are ignored. */
  observe(headers: ReadonlyMap<string, string>): void;
  readonly remaining: number | null;
}

export type BudgetResource = "core" | "graphql";

export interface RateBudgetOptions {
  floor?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export function rateBudget(options: RateBudgetOptions = {}): RateBudget {
  const floor = options.floor ?? RATE_FLOOR;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const windows: Record<BudgetResource, Window> = { core: { remaining: null, resetAtMs: 0 }, graphql: { remaining: null, resetAtMs: 0 } };
  return {
    get remaining() {
      return windows.core.remaining;
    },
    observe(headers) {
      const observed = rateHeaders(headers);
      if (observed) Object.assign(windows[observed.resource], { remaining: observed.remaining, resetAtMs: observed.resetAtMs });
    },
    async acquire(resource = "core") {
      const window = windows[resource];
      const wait = backoffMs(window.remaining, window.resetAtMs, floor, now());
      if (wait > 0) await sleep(wait);
      if (window.remaining !== null) window.remaining = now() >= window.resetAtMs ? null : Math.max(0, window.remaining - 1);
    },
  };
}

/** Spreads the calls left over the time left, so a low budget slows callers instead of exhausting them. */
export function backoffMs(remaining: number | null, resetAtMs: number, floor: number, nowMs: number): number {
  if (remaining === null || remaining >= floor || nowMs >= resetAtMs) return 0;
  return Math.ceil((resetAtMs - nowMs) / Math.max(remaining, 1));
}

interface Window {
  remaining: number | null;
  resetAtMs: number;
}

function rateHeaders(headers: ReadonlyMap<string, string>): { resource: BudgetResource; remaining: number; resetAtMs: number } | null {
  const resource = headers.get("x-ratelimit-resource") ?? "core";
  if (resource !== "core" && resource !== "graphql") return null;
  const remaining = Number(headers.get("x-ratelimit-remaining"));
  const reset = Number(headers.get("x-ratelimit-reset"));
  if (!headers.has("x-ratelimit-remaining") || !Number.isFinite(remaining) || !Number.isFinite(reset)) return null;
  return { resource, remaining, resetAtMs: reset * 1000 };
}

/** The default for every `ghCliWire` in this process, because GitHub counts calls per login, not per wire. */
export const sharedRateBudget: RateBudget = rateBudget();
