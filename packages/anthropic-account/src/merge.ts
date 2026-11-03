import { POLL_SESSION_ID, type ObservedReading, type UsageWindow } from "./usage.js";

export type { ObservedReading };

export interface AccountWindow {
  used_pct: number;
  resets_at?: number;
  severity?: string;
  /** Every reading's reset has passed: a new window is open and nothing has been read from it. */
  rolled?: true;
}

export interface AccountUsage {
  account: string;
  config_dirs: string[];
  identity?: string;
  source: "oauth-usage" | "status-line" | null;
  windows: Record<string, AccountWindow>;
  scoped?: { model: string; used_pct: number; severity?: string };
  age_seconds: number | null;
  stale: boolean;
  auth_fail: boolean;
}

export type AccountReadings = Pick<AccountUsage, "account" | "config_dirs" | "identity"> & {
  auth_fail?: boolean;
  readings: readonly ObservedReading[];
};

// The poller's reading is the reading of record while it is no older than this.
const POLLER_RECORD_SECONDS = 360;
const STATUS_LINE_STALE_SECONDS = 120;
// The oldest reading that may lend or raise a window; an older one may hide spend since.
const MAX_LENDER_AGE_SECONDS = 15 * 60;
// Two resets_at this close name the same window; a status line's figure can lag the poller's.
const SAME_WINDOW_SECONDS = 3600;

type Aged = { reading: ObservedReading; age: number };
type Candidate = { window: AccountWindow; age: number };

function ttlSeconds(ttl: string | undefined): number {
  const match = /^(\d+)([smh])$/.exec(ttl ?? "");
  if (match === null) return 0;
  const [, count, unit] = match;
  return Number(count) * (unit === "h" ? 3600 : unit === "m" ? 60 : 1);
}

// A status line restamps written_at on every redraw, but its rate_limits only change on an API
// response, which also set prompt_cache.expires_at to its own time plus the ttl.
function observedAt(reading: ObservedReading): number {
  const expiresAt = reading.prompt_cache?.expires_at;
  if (expiresAt === undefined) return reading.written_at;
  return Math.min(reading.written_at, expiresAt - ttlSeconds(reading.prompt_cache?.ttl));
}

const isPoller = (reading: ObservedReading): boolean => reading.session_id === POLL_SESSION_ID;
const isPassed = (window: AccountWindow, nowS: number): boolean =>
  window.resets_at !== undefined && window.resets_at <= nowS;
const toWindow = (w: UsageWindow): AccountWindow =>
  w.resets_at === undefined ? { used_pct: w.used_percentage } : { used_pct: w.used_percentage, resets_at: w.resets_at };
const youngest = (aged: readonly Aged[]): Aged => aged.reduce((a, b) => (b.age < a.age ? b : a));

/** The reading of record first, then the readings that may lend to it, newest written first. */
function recordAndLenders(aged: readonly Aged[]): { record: Aged; lenders: Aged[] } {
  const poller = aged.find((a) => isPoller(a.reading) && a.age <= POLLER_RECORD_SECONDS);
  const current = aged.filter((a) => a.age <= MAX_LENDER_AGE_SECONDS);
  const pool = current.length > 0 ? current : [youngest(aged)];
  const byWritten = [...pool].sort((a, b) => b.reading.written_at - a.reading.written_at);
  const record = poller ?? byWritten[0] ?? youngest(aged);
  return { record, lenders: byWritten.filter((a) => a !== record) };
}

/** May this lender's window join the candidates for a window the record already holds? */
function mayLend(window: AccountWindow, held: Candidate[] | undefined, anchor: AccountWindow | undefined, nowS: number) {
  if (held === undefined) return !isPassed(window, nowS);
  if (anchor?.resets_at === undefined || isPassed(anchor, nowS)) return true;
  return window.resets_at !== undefined && Math.abs(window.resets_at - anchor.resets_at) <= SAME_WINDOW_SECONDS;
}

function windowCandidates(record: Aged, lenders: readonly Aged[], nowS: number): Map<string, Candidate[]> {
  const byName = new Map<string, Candidate[]>();
  for (const [name, w] of Object.entries(record.reading.rate_limits))
    byName.set(name, [{ window: toWindow(w), age: record.age }]);
  const anchored = isPoller(record.reading) && record.age <= POLLER_RECORD_SECONDS;
  for (const lender of lenders)
    for (const [name, w] of Object.entries(lender.reading.rate_limits)) {
      const window = toWindow(w);
      const anchor = anchored ? byName.get(name)?.[0]?.window : undefined;
      if (!mayLend(window, byName.get(name), anchor, nowS)) continue;
      byName.set(name, [...(byName.get(name) ?? []), { window, age: lender.age }]);
    }
  return byName;
}

/**
 * Usage only rises inside one window, so the latest resets_at group (±1 h) wins with its highest
 * figure. A passed reset is dropped; when nothing else is left the window has rolled to 0.
 */
function pickWindow(candidates: readonly Candidate[], nowS: number): Candidate {
  const live = candidates.filter((c) => !isPassed(c.window, nowS));
  const [first] = live;
  if (first === undefined) return { window: { used_pct: 0, rolled: true }, age: Math.min(...candidates.map((c) => c.age)) };
  if (first.window.resets_at === undefined) return first;
  const timed = live.flatMap((c) => (c.window.resets_at === undefined ? [] : [{ c, resetsAt: c.window.resets_at }]));
  const latest = Math.max(...timed.map((t) => t.resetsAt));
  return timed
    .filter((t) => latest - t.resetsAt <= SAME_WINDOW_SECONDS)
    .map((t) => t.c)
    .reduce((best, c) => (c.window.used_pct > best.window.used_pct ? c : best));
}

/** One account's usage from its readings: a fresh poller is the record; others lend or raise windows. */
export function mergeAccountReadings(input: AccountReadings, now: number): AccountUsage {
  const nowS = now / 1000;
  const base = { account: input.account, config_dirs: input.config_dirs, auth_fail: input.auth_fail ?? false };
  const identity = input.identity === undefined ? {} : { identity: input.identity };
  if (input.readings.length === 0)
    return { ...base, ...identity, source: null, windows: {}, age_seconds: null, stale: false };
  const aged = input.readings.map((reading) => ({ reading, age: Math.max(0, Math.round(nowS - observedAt(reading))) }));
  const { record, lenders } = recordAndLenders(aged);
  const windows: Record<string, AccountWindow> = {};
  let age = record.age;
  for (const [name, candidates] of windowCandidates(record, lenders, nowS)) {
    const picked = pickWindow(candidates, nowS);
    windows[name] = picked.window;
    age = Math.max(age, picked.age);
  }
  const poller = isPoller(record.reading);
  const staleAfter = poller ? POLLER_RECORD_SECONDS : STATUS_LINE_STALE_SECONDS;
  const source = poller ? "oauth-usage" : "status-line";
  return { ...base, ...identity, source, windows, age_seconds: age, stale: age > staleAfter };
}
