import { assertAccountLabel } from "./profile.js";
import { knownObservation, type UsageResult, type UsageWindow } from "./usage.js";

export interface NativeQuotaObservation {
  account: string;
  expectedAccountId: string;
  /** Local backend-request start, not a server-supplied snapshot generation time. */
  startedAt: number;
}
export function nativeRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function epoch(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 1e9 && value < 1e11;
}
function window(value: unknown, minutes: number, at: number): UsageWindow | undefined {
  if (!nativeRecord(value) || value.windowDurationMins !== minutes || typeof value.usedPercent !== "number" ||
      !Number.isFinite(value.usedPercent) || value.usedPercent < 0 || value.usedPercent > 100 ||
      !epoch(value.resetsAt) || value.resetsAt <= at) return undefined;
  return { used_percentage: value.usedPercent, resets_at: value.resetsAt };
}
function snapshot(value: unknown, at: number) {
  if (!nativeRecord(value) || value.limitId !== "codex" || value.spendControlReached === true) return undefined;
  const five_hour = window(value.primary, 300, at) ?? window(value.secondary, 300, at);
  const seven_day = window(value.secondary, 10080, at) ?? window(value.primary, 10080, at);
  return five_hour && seven_day ? { five_hour, seven_day } : undefined;
}

/** Only for a successful matching native backend request; raw rollouts cannot establish this provenance. */
export function usageFromNativeResponse(input: unknown, observation: NativeQuotaObservation): UsageResult {
  assertAccountLabel(observation.account);
  try {
    if (!observation.expectedAccountId || !epoch(observation.startedAt) || !nativeRecord(input) ||
        input.accountId !== observation.expectedAccountId || input.ordinaryUsageAllowed !== true ||
        !nativeRecord(input.rateLimitsByLimitId)) return { status: "unknown", reason: "inconsistent" };
    const limits = snapshot(input.rateLimitsByLimitId.codex, observation.startedAt);
    const legacy = snapshot(input.rateLimits, observation.startedAt);
    if (!limits || !legacy || JSON.stringify(limits) !== JSON.stringify(legacy)) return { status: "unknown", reason: "inconsistent" };
    return knownObservation({
      source: "native-account/rateLimits/read:request-start-lower-bound",
      observedAt: observation.startedAt,
      reading: { account: observation.account, rate_limits: limits },
    });
  } catch { return { status: "unknown", reason: "inconsistent" }; }
}
