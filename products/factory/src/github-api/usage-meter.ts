import type { Logger } from "@titan-design/daemon";
import { startSweep, type Sweep } from "../sweep.js";

/** The F11 meter's 5-minute line: each resource's open window so far. */
export const USAGE_LOG_MS = 5 * 60_000;
/** The F11 meter's hourly line: every window an answer touched since the last one. */
export const PEAK_LOG_MS = 60 * 60_000;

/** One reset window of one resource: the most of `limit` any answer inside it reported used. `reset` is GitHub's epoch seconds. */
export interface UsageWindow {
  resource: string;
  used: number;
  limit: number;
  reset: number;
}

export interface UsageMeter {
  /** Fed every response's headers; an answer without a full rate-limit header set is ignored. */
  observe(headers: Headers): void;
  /** Each resource's latest window. */
  current(): UsageWindow[];
  /**
   * Every window an answer touched since the last take, at its max. A window open across two takes appears in both, so
   * a reader keeps the max per (resource, reset); that also merges the windows a restart splits.
   */
  takePeaks(): UsageWindow[];
}

/** Keyed by the window, not the resource alone: a reset drops `used` to zero, and the peak is the max before it. */
export function usageMeter(): UsageMeter {
  const latest = new Map<string, UsageWindow>();
  let touched = new Map<string, UsageWindow>();
  return {
    observe(headers) {
      const read = readUsage(headers);
      if (read === undefined) return;
      const key = `${read.resource}@${read.reset}`;
      const prior = latest.get(read.resource);
      const seed = touched.get(key) ?? (prior?.reset === read.reset ? prior : undefined);
      const window = seed !== undefined && seed.used >= read.used ? seed : read;
      touched.set(key, window);
      if (prior === undefined || read.reset >= prior.reset) latest.set(read.resource, window);
    },
    current: () => [...latest.values()],
    takePeaks() {
      const taken = [...touched.values()];
      touched = new Map();
      return taken;
    },
  };
}

function readUsage(headers: Headers): UsageWindow | undefined {
  const resource = headers.get("x-ratelimit-resource");
  const used = count(headers.get("x-ratelimit-used"));
  const limit = count(headers.get("x-ratelimit-limit"));
  const reset = count(headers.get("x-ratelimit-reset"));
  if (resource === null || used === undefined || limit === undefined || reset === undefined || limit === 0) return undefined;
  return { resource, used, limit, reset };
}

function count(header: string | null): number | undefined {
  if (header === null || !/^\d+$/.test(header)) return undefined;
  const value = Number(header);
  return Number.isSafeInteger(value) ? value : undefined;
}

function fields(identity: string, window: UsageWindow): Record<string, unknown> {
  const { resource, used, limit, reset } = window;
  return { identity, resource, used, limit, pct: Math.round((used * 100) / limit), reset: new Date(reset * 1000).toISOString() };
}

export function logUsage(meter: UsageMeter, identity: string, log: Logger): void {
  for (const window of meter.current()) log.info(fields(identity, window), "github-api.usage");
}

export function logPeaks(meter: UsageMeter, identity: string, log: Logger): void {
  for (const window of meter.takePeaks()) log.info(fields(identity, window), "github-api.peak");
}

/** Lines only, never /health, so the F11 report reads the serve log alone. */
export function startUsageLog(meter: UsageMeter, identity: string, log: Logger): Sweep[] {
  return [
    startSweep(async () => logUsage(meter, identity, log), USAGE_LOG_MS, "github-api usage line", log),
    startSweep(async () => logPeaks(meter, identity, log), PEAK_LOG_MS, "github-api peak line", log),
  ];
}
