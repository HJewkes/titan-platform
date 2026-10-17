import { a as LoginStatusOutput, A as AccountProfile, L as LoginState, b as UsageResult } from './usage.js';

interface LoginProbeInput {
    executablePath: string;
    args: readonly ["login", "status"];
    env: Record<string, string>;
    timeoutMs: number;
    signal?: AbortSignal;
}
interface ReadLoginOptions {
    executablePath?: string;
    env?: Record<string, string | undefined>;
    timeoutMs?: number;
    signal?: AbortSignal;
    runStatus?: (input: LoginProbeInput) => Promise<LoginStatusOutput>;
}
/** Model-free login status only. No auth-file reads, provisioning, login or fallback. */
declare function readLoginState(profile: AccountProfile, options?: ReadLoginOptions): Promise<LoginState>;

interface ReadUsageOptions {
    /** Total bytes across all rollouts; exceeding the bound gives unknown, never a partial reading. */
    maxBytes?: number;
    maxFiles?: number;
}
/** Read active and archived rollout JSONL only, never auth.json; any scan failure refuses. */
declare function readUsage(profile: AccountProfile, options?: ReadUsageOptions): Promise<UsageResult>;

export { type LoginProbeInput, type ReadLoginOptions, type ReadUsageOptions, readLoginState, readUsage };

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
