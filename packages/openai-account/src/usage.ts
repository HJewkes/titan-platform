import { assertAccountLabel } from "./profile.js";

export interface UsageWindow { used_percentage: number; resets_at: number }
export interface UsageReading {
  account: string;
  /** Quota observation lower bound in epoch seconds; a verified backend request start is valid, a rollout emission or file read is not. */
  written_at: number;
  rate_limits: { five_hour: UsageWindow; seven_day: UsageWindow };
}
export type UsageResult =
  | { status: "known"; reading: UsageReading }
  | { status: "unknown"; reason: "missing" | "inconsistent" | "unreadable" | "freshness-unverified" };
export type QuotaAdmission =
  | { allowed: true; ageSeconds: number }
  | { allowed: false; reason: "missing" | "inconsistent" | "unreadable" | "freshness-unverified" | "stale" | "weekly-reserve" | "five-hour-ceiling"; ageSeconds?: number };
export const MAX_READING_AGE_SECONDS = 900;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function object(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}
function epoch(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 1e9 && value < 1e11;
}
function window(value: unknown, minutes: number, at: number): UsageWindow | undefined {
  const data = object(value);
  if (!data || data.window_minutes !== minutes || typeof data.used_percent !== "number" ||
      !Number.isFinite(data.used_percent) || data.used_percent < 0 || data.used_percent > 100 ||
      !epoch(data.resets_at) || data.resets_at <= at) return undefined;
  return { used_percentage: data.used_percent, resets_at: data.resets_at };
}
function reading(limits: unknown, account: string, at: number): UsageResult {
  const data = object(limits);
  if (!data || (data.limit_id !== undefined && data.limit_id !== "codex")) return unknown("inconsistent");
  const five = window(data.primary, 300, at) ?? window(data.secondary, 300, at);
  const week = window(data.secondary, 10080, at) ?? window(data.primary, 10080, at);
  if (!five || !week) return unknown("inconsistent");
  return { status: "known", reading: { account, written_at: at, rate_limits: { five_hour: five, seven_day: week } } };
}
function unknown(reason: "missing" | "inconsistent" | "freshness-unverified"): UsageResult { return { status: "unknown", reason }; }

function validWindow(window: UsageWindow, now: number): boolean {
  return Number.isFinite(window.used_percentage) && window.used_percentage >= 0 && window.used_percentage <= 100 &&
    epoch(window.resets_at) && window.resets_at > now;
}

/** Validate newest rollout quota evidence; native emission times cannot establish freshness. */
export function usageFromRolloutEvents(events: Iterable<unknown>, account: string): UsageResult {
  assertAccountLabel(account);
  let newest = -Infinity;
  let result = unknown("missing");
  try {
    for (const input of events) {
      const event = object(input);
      const payload = object(event?.payload);
      if (event?.type !== "event_msg" || payload?.type !== "token_count") continue;
      const at = typeof event.timestamp === "string" ? Date.parse(event.timestamp) / 1000 : NaN;
      if (!epoch(at)) return unknown("inconsistent");
      const candidate = reading(payload.rate_limits, account, at);
      if (at > newest) { newest = at; result = candidate; }
      else if (at === newest && JSON.stringify(candidate) !== JSON.stringify(result)) result = unknown("inconsistent");
    }
    // Codex can re-emit cached quota on a local token update, without a server fetch.
    return result.status === "known" ? unknown("freshness-unverified") : result;
  } catch { return unknown("inconsistent"); }
}

/** Q5: reserve 14 weekly points, 5h ceiling 100, and at most 15-minute-old evidence. */
export function quotaAdmission(result: UsageResult, now: number): QuotaAdmission {
  if (result.status === "unknown") return { allowed: false, reason: result.reason };
  const { written_at: at, rate_limits: limits } = result.reading;
  const age = now - at;
  if (!epoch(at) || !epoch(now) || age < 0 || !validWindow(limits.five_hour, now) || !validWindow(limits.seven_day, now)) {
    return { allowed: false, reason: "inconsistent" };
  }
  if (age > MAX_READING_AGE_SECONDS) return { allowed: false, reason: "stale", ageSeconds: age };
  if (limits.five_hour.used_percentage >= 100) return { allowed: false, reason: "five-hour-ceiling", ageSeconds: age };
  if (limits.seven_day.used_percentage > 86) return { allowed: false, reason: "weekly-reserve", ageSeconds: age };
  return { allowed: true, ageSeconds: age };
}
