import { assertAccountLabel } from "./profile.js";

export interface UsageWindow { used_percentage: number; resets_at: number }
export interface UsageReading {
  account: string;
  /** Quota observation time, in epoch seconds; never an emission or read time. */
  written_at: number;
  rate_limits: { five_hour: UsageWindow; seven_day: UsageWindow };
}
declare const KNOWN_OBSERVATION: unique symbol;
const knownObservations = new WeakSet<object>();
interface ObservationTime { readonly source: string; readonly observedAt: number }
export type KnownUsageReading = UsageReading & { readonly [KNOWN_OBSERVATION]: ObservationTime };
function recordKnownObservation(reading: UsageReading): asserts reading is KnownUsageReading {
  knownObservations.add(reading);
}
export interface KnownObservationInput {
  /** Explicit caller attestation of the time source; not authentication or backend proof. */
  readonly source: string;
  readonly observedAt: number;
  readonly reading: Omit<UsageReading, "written_at">;
}
type UnknownReason = "missing" | "inconsistent" | "unreadable" | "freshness-unverified";
type UnknownUsage = { status: "unknown"; reason: UnknownReason };
export type UsageResult = { status: "known"; reading: KnownUsageReading } | UnknownUsage;
export type QuotaAdmission =
  | { allowed: true; ageSeconds: number }
  | { allowed: false; reason: UnknownReason | "stale" | "weekly-reserve" | "five-hour-ceiling"; ageSeconds?: number };
export const MAX_READING_AGE_SECONDS = 900;
function knownUnknownReason(value: unknown): UnknownReason {
  switch (value) {
    case "missing": case "inconsistent": case "unreadable": case "freshness-unverified": return value;
    default: return "inconsistent";
  }
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function object(value: unknown): Record<PropertyKey, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}
function epoch(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 1e9 && value < 1e11;
}
function unknown(reason: UnknownReason): UnknownUsage { return { status: "unknown", reason }; }
function checkedWindow(value: unknown, at: number): UsageWindow | undefined {
  const data = object(value); const used = data?.used_percentage; const reset = data?.resets_at;
  if (typeof used !== "number" || !Number.isFinite(used) || used < 0 || used > 100 || !epoch(reset) || reset <= at) return undefined;
  return { used_percentage: used, resets_at: reset };
}

/** Explicit provenance opt-in. Serialized/raw readings must never silently reacquire this brand. */
export function knownObservation(input: KnownObservationInput): UsageResult {
  try {
    const { source, observedAt, reading: supplied } = input;
    if (typeof source !== "string" || !source.trim() || !epoch(observedAt) || !isRecord(supplied)) return unknown("inconsistent");
    const account = supplied.account; const limits = object(supplied.rate_limits);
    if (typeof account !== "string" || !limits) return unknown("inconsistent");
    assertAccountLabel(account);
    const five_hour = checkedWindow(limits.five_hour, observedAt);
    const seven_day = checkedWindow(limits.seven_day, observedAt);
    if (!five_hour || !seven_day) return unknown("inconsistent");
    const reading = Object.freeze({
      account, written_at: observedAt,
      rate_limits: Object.freeze({
        five_hour: Object.freeze(five_hour), seven_day: Object.freeze(seven_day),
      }),
    });
    recordKnownObservation(reading);
    return { status: "known", reading };
  } catch { return unknown("inconsistent"); }
}

function rolloutWindow(value: unknown, minutes: number, at: number): UsageWindow | undefined {
  const data = object(value);
  if (!data || data.window_minutes !== minutes || typeof data.used_percent !== "number" ||
      !Number.isFinite(data.used_percent) || data.used_percent < 0 || data.used_percent > 100 ||
      !epoch(data.resets_at) || data.resets_at <= at) return undefined;
  return { used_percentage: data.used_percent, resets_at: data.resets_at };
}
/** Internal evidence validation, deliberately unbranded and absent from the public root exports. */
export function validateRolloutWindows(limits: unknown, at: number): UsageReading["rate_limits"] | undefined {
  const data = object(limits);
  if (!data || (data.limit_id !== undefined && data.limit_id !== "codex")) return undefined;
  const five = rolloutWindow(data.primary, 300, at) ?? rolloutWindow(data.secondary, 300, at);
  const week = rolloutWindow(data.secondary, 10080, at) ?? rolloutWindow(data.primary, 10080, at);
  return five && week ? { five_hour: five, seven_day: week } : undefined;
}
type RolloutEvidence = { status: "valid"; windows: UsageReading["rate_limits"] } | UnknownUsage;
function rolloutEvidence(limits: unknown, at: number): RolloutEvidence {
  const windows = validateRolloutWindows(limits, at);
  return windows ? { status: "valid", windows } : unknown("inconsistent");
}

/** Validate newest rollout evidence; native emission times cannot establish freshness. */
export function usageFromRolloutEvents(events: Iterable<unknown>, account: string): UsageResult {
  assertAccountLabel(account);
  let newest = -Infinity;
  let result: RolloutEvidence = unknown("missing");
  try {
    for (const input of events) {
      const event = object(input); const payload = object(event?.payload);
      if (event?.type !== "event_msg" || payload?.type !== "token_count") continue;
      const at = typeof event.timestamp === "string" ? Date.parse(event.timestamp) / 1000 : NaN;
      if (!epoch(at)) return unknown("inconsistent");
      const candidate = rolloutEvidence(payload.rate_limits, at);
      if (at > newest) { newest = at; result = candidate; }
      else if (at === newest && JSON.stringify(candidate) !== JSON.stringify(result)) result = unknown("inconsistent");
    }
    return result.status === "valid" ? unknown("freshness-unverified") : result;
  } catch { return unknown("inconsistent"); }
}

function admitKnown(value: unknown, now: number): QuotaAdmission {
  const reading = object(value);
  if (!reading || !knownObservations.has(reading)) return { allowed: false, reason: "inconsistent" };
  const at = reading.written_at; const limits = object(reading.rate_limits);
  if (!epoch(at) || !epoch(now) || now < at || !limits) return { allowed: false, reason: "inconsistent" };
  const five = checkedWindow(limits.five_hour, now); const week = checkedWindow(limits.seven_day, now);
  if (!five || !week) return { allowed: false, reason: "inconsistent" };
  const age = now - at;
  if (age > MAX_READING_AGE_SECONDS) return { allowed: false, reason: "stale", ageSeconds: age };
  if (five.used_percentage >= 100) return { allowed: false, reason: "five-hour-ceiling", ageSeconds: age };
  if (week.used_percentage > 86) return { allowed: false, reason: "weekly-reserve", ageSeconds: age };
  return { allowed: true, ageSeconds: age };
}
/** Q5 policy; only explicit, locally branded observations can enter the known path. */
export function quotaAdmission(result: UsageResult, now: number): QuotaAdmission;
export function quotaAdmission(result: unknown, now: number): QuotaAdmission {
  try {
    if (!isRecord(result)) return { allowed: false, reason: "inconsistent" };
    const status = result.status;
    if (status === "unknown") {
      const reason = result.reason;
      return { allowed: false, reason: knownUnknownReason(reason) };
    }
    if (status !== "known") return { allowed: false, reason: "inconsistent" };
    return admitKnown(result.reading, now);
  } catch { return { allowed: false, reason: "inconsistent" }; }
}
