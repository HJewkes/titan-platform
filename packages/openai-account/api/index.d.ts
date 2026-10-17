export { A as AccountProfile, L as LoginState, a as LoginStatusOutput, M as MAX_READING_AGE_SECONDS, Q as QuotaAdmission, U as UsageReading, b as UsageResult, c as UsageWindow, d as accountLabel, e as assertAccountLabel, l as loginStateFromStatus, q as quotaAdmission, u as usageFromRolloutEvents } from './usage.js';

/** Reuse Titan redaction, adding OpenAI key prefixes; no cause or extra fields survive. */
declare function redactSecrets(value: string): string;
declare function redactSecrets(value: Error): Error;

export { redactSecrets };

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
    /** Quota observation time established by the caller, in epoch seconds; never an emission or read time. */
    written_at: number;
    rate_limits: {
        five_hour: UsageWindow;
        seven_day: UsageWindow;
    };
}
type UsageResult = {
    status: "known";
    reading: UsageReading;
} | {
    status: "unknown";
    reason: "missing" | "inconsistent" | "unreadable" | "freshness-unverified";
};
type QuotaAdmission = {
    allowed: true;
    ageSeconds: number;
} | {
    allowed: false;
    reason: "missing" | "inconsistent" | "unreadable" | "freshness-unverified" | "stale" | "weekly-reserve" | "five-hour-ceiling";
    ageSeconds?: number;
};
declare const MAX_READING_AGE_SECONDS = 900;
/** Validate newest rollout quota evidence; native emission times cannot establish freshness. */
declare function usageFromRolloutEvents(events: Iterable<unknown>, account: string): UsageResult;
/** Q5: reserve 14 weekly points, 5h ceiling 100, and at most 15-minute-old evidence. */
declare function quotaAdmission(result: UsageResult, now: number): QuotaAdmission;

export { type AccountProfile as A, type LoginState as L, MAX_READING_AGE_SECONDS as M, type QuotaAdmission as Q, type UsageReading as U, type LoginStatusOutput as a, type UsageResult as b, type UsageWindow as c, accountLabel as d, assertAccountLabel as e, loginStateFromStatus as l, quotaAdmission as q, usageFromRolloutEvents as u };
