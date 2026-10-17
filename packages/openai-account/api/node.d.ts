import { b as LoginStatusOutput, A as AccountProfile, L as LoginState, U as UsageResult } from './usage.js';

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

type NativeQuotaMethod = "initialize" | "account/read" | "account/rateLimits/read";
interface NativeQuotaProcessInput {
    executablePath: string;
    cwd: string;
    env: Record<string, string>;
    signal: AbortSignal;
}
interface NativeQuotaConnection {
    request(method: NativeQuotaMethod, params: Record<string, unknown>): Promise<unknown>;
    initialized(): void;
    close(): void;
}
type ConnectNativeQuota = (input: NativeQuotaProcessInput, invalidated: () => void) => NativeQuotaConnection;

interface NativeQuotaWorkspace {
    cwd: string;
    dispose(): Promise<void>;
}

interface ReadNativeUsageOptions {
    /** Nonsecret account binding from the caller account authority; never infer from label/email. */
    expectedAccountId: string;
    executablePath?: string;
    env?: Record<string, string | undefined>;
    timeoutMs?: number;
    signal?: AbortSignal;
    createWorkspace?: () => Promise<NativeQuotaWorkspace>;
    resolveExecutable?: (executable: string, env: Record<string, string>) => Promise<string>;
    inspectVersion?: (input: NativeQuotaProcessInput) => Promise<string>;
    connect?: ConnectNativeQuota;
    now?: () => number;
    monotonicNow?: () => number;
}
/** Opt-in native backend fetch. Native may refresh its own credentials; no login or model operation is requested. */
declare function readNativeUsage(profile: AccountProfile, options: ReadNativeUsageOptions): Promise<UsageResult>;

export { type ConnectNativeQuota, type LoginProbeInput, type NativeQuotaConnection, type NativeQuotaProcessInput, type NativeQuotaWorkspace, type ReadLoginOptions, type ReadNativeUsageOptions, type ReadUsageOptions, readLoginState, readNativeUsage, readUsage };

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
