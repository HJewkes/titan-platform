import { U as UsageResult } from './usage.js';
export { A as AccountProfile, K as KnownObservationInput, a as KnownUsageReading, L as LoginState, b as LoginStatusOutput, M as MAX_READING_AGE_SECONDS, Q as QuotaAdmission, c as UsageReading, d as UsageWindow, e as accountLabel, f as assertAccountLabel, k as knownObservation, l as loginStateFromStatus, q as quotaAdmission, u as usageFromRolloutEvents } from './usage.js';

/** Reuse Titan redaction, adding OpenAI key prefixes; no cause or extra fields survive. */
declare function redactSecrets(value: string): string;
declare function redactSecrets(value: Error): Error;

interface NativeQuotaObservation {
    account: string;
    expectedAccountId: string;
    /** Local backend-request start, not a server-supplied snapshot generation time. */
    startedAt: number;
}
/** Only for a successful matching native backend request; raw rollouts cannot establish this provenance. */
declare function usageFromNativeResponse(input: unknown, observation: NativeQuotaObservation): UsageResult;

export { type NativeQuotaObservation, UsageResult, redactSecrets, usageFromNativeResponse };

// ./dist/usage.d.ts
interface AccountProfile {
    label: string;
    codeHome: string;
}
declare function assertAccountLabel(label: string): void;
/** Labels identify an explicitly selected home; they are not authentication identities. */
declare function accountLabel(codeHome: string): string;

type LoginState = {
    status: "present";
    method: "chatgpt";
} | {
    status: "missing";
} | {
    status: "refused";
    reason: "unsupported-method" | "unrecognized-output" | "probe-failed";
};
interface LoginStatusOutput {
    exitCode: number | null;
    stdout: string;
    stderr: string;
}
/** Exact recognized status text only; never return CLI output or credential material. */
declare function loginStateFromStatus(output: LoginStatusOutput): LoginState;

interface UsageWindow {
    used_percentage: number;
    resets_at: number;
}
interface UsageReading {
    account: string;
    /** Quota observation time, in epoch seconds; never an emission or read time. */
    written_at: number;
    rate_limits: {
        five_hour: UsageWindow;
        seven_day: UsageWindow;
    };
}
declare const KNOWN_OBSERVATION: unique symbol;
interface ObservationTime {
    readonly source: string;
    readonly observedAt: number;
}
type KnownUsageReading = UsageReading & {
    readonly [KNOWN_OBSERVATION]: ObservationTime;
};
interface KnownObservationInput {
    /** Explicit caller attestation of the time source; not authentication or backend proof. */
    readonly source: string;
    readonly observedAt: number;
    readonly reading: Omit<UsageReading, "written_at">;
}
type UnknownReason = "missing" | "inconsistent" | "unreadable" | "freshness-unverified";
type UnknownUsage = {
    status: "unknown";
    reason: UnknownReason;
};
type UsageResult = {
    status: "known";
    reading: KnownUsageReading;
} | UnknownUsage;
type QuotaAdmission = {
    allowed: true;
    ageSeconds: number;
} | {
    allowed: false;
    reason: UnknownReason | "stale" | "weekly-reserve" | "five-hour-ceiling";
    ageSeconds?: number;
};
declare const MAX_READING_AGE_SECONDS = 900;
/** Explicit provenance opt-in. Serialized/raw readings must never silently reacquire this brand. */
declare function knownObservation(input: KnownObservationInput): UsageResult;
/** Validate newest rollout evidence; native emission times cannot establish freshness. */
declare function usageFromRolloutEvents(events: Iterable<unknown>, account: string): UsageResult;
/** Q5 policy; only explicit, locally branded observations can enter the known path. */
declare function quotaAdmission(result: UsageResult, now: number): QuotaAdmission;

export { type AccountProfile as A, type KnownObservationInput as K, type LoginState as L, MAX_READING_AGE_SECONDS as M, type QuotaAdmission as Q, type UsageResult as U, type KnownUsageReading as a, type LoginStatusOutput as b, type UsageReading as c, type UsageWindow as d, accountLabel as e, assertAccountLabel as f, knownObservation as k, loginStateFromStatus as l, quotaAdmission as q, usageFromRolloutEvents as u };
