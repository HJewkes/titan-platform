export { A as AccountProfile, a as AccountReadings, b as AccountUsage, c as AccountWindow, D as DEFAULT_LABEL, L as LoginState, O as OAuthUsageOptions, d as ObservedReading, P as POLL_SESSION_ID, e as POLL_SOURCE, R as RefusedReason, U as UsageReading, f as UsageWindow, g as accountLabel, l as loginStateFromCredentials, m as mergeAccountReadings, n as needsRefresh, p as parseObservedReading, h as parseUsageReading, u as usageFromOAuthResponse } from './merge.js';
import 'zod';

declare const REDACTED = "[REDACTED]";
declare function redactSecrets(value: string): string;
declare function redactSecrets(value: Error): Error;

interface IdentityGroup<T> {
    identity?: string;
    members: T[];
}
/**
 * CC-1289: items grouped by the Anthropic login each bills, in first-seen order. An item whose
 * login cannot be read is its own group, so API-key profiles never merge with each other.
 */
declare function groupByIdentity<T>(items: Iterable<T>, identify: (item: T) => string | undefined): IdentityGroup<T>[];

export { type IdentityGroup, REDACTED, groupByIdentity, redactSecrets };

// ./dist/merge.d.ts
import { z } from 'zod';

declare const windowSchema: z.ZodObject<{
    used_percentage: z.ZodNumber;
    resets_at: z.ZodOptional<z.ZodNumber>;
    severity: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
declare const usageReadingSchema: z.ZodObject<{
    session_id: z.ZodString;
    written_at: z.ZodNumber;
    rate_limits: z.ZodRecord<z.ZodString, z.ZodObject<{
        used_percentage: z.ZodNumber;
        resets_at: z.ZodOptional<z.ZodNumber>;
        severity: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
    scoped: z.ZodOptional<z.ZodObject<{
        model: z.ZodString;
        used_pct: z.ZodNumber;
        severity: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
    source: z.ZodOptional<z.ZodString>;
    account: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
declare const observedReadingSchema: z.ZodObject<{
    session_id: z.ZodString;
    written_at: z.ZodNumber;
    rate_limits: z.ZodRecord<z.ZodString, z.ZodObject<{
        used_percentage: z.ZodNumber;
        resets_at: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
    source: z.ZodOptional<z.ZodString>;
    account: z.ZodOptional<z.ZodString>;
    prompt_cache: z.ZodCatch<z.ZodOptional<z.ZodObject<{
        ttl: z.ZodOptional<z.ZodString>;
        expires_at: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>>;
}, z.core.$strip>;
type UsageWindow = z.infer<typeof windowSchema>;
type UsageReading = z.infer<typeof usageReadingSchema>;
/** A stored reading, with the prompt-cache stamp a status line writes beside its rate_limits. */
type ObservedReading = z.infer<typeof observedReadingSchema>;
declare const POLL_SESSION_ID = "usage-poll";
declare const POLL_SOURCE = "oauth-usage";
declare function parseUsageReading(input: unknown): UsageReading | null;
declare function parseObservedReading(input: unknown): ObservedReading | null;
interface OAuthUsageOptions {
    writtenAt: number;
    account?: string;
}
declare function usageFromOAuthResponse(body: unknown, options: OAuthUsageOptions): UsageReading | null;

type RefusedReason = "malformed" | "mode-too-wide" | "foreign-owner" | "not-a-regular-file" | "hard-linked";
type LoginState = {
    status: "present";
    expiresAt: number;
    canRefresh: boolean;
    subscriptionType?: string;
    rateLimitTier?: string;
} | {
    status: "expired";
    expiresAt: number;
    canRefresh: boolean;
} | {
    status: "missing";
} | {
    status: "refused";
    reason: RefusedReason;
};
declare function loginStateFromCredentials(credentials: unknown, now: number): LoginState;
declare function needsRefresh(state: LoginState, now: number, marginMs: number): boolean;

interface AccountProfile {
    label: string;
    configDir: string;
}
declare const DEFAULT_LABEL = "default";
declare function accountLabel(configDir: string): string;

interface AccountWindow {
    used_pct: number;
    resets_at?: number;
    severity?: string;
    /** Every reading's reset has passed: a new window is open and nothing has been read from it. */
    rolled?: true;
}
interface AccountUsage {
    account: string;
    config_dirs: string[];
    identity?: string;
    source: "oauth-usage" | "status-line" | null;
    windows: Record<string, AccountWindow>;
    scoped?: {
        model: string;
        used_pct: number;
        severity?: string;
    };
    age_seconds: number | null;
    stale: boolean;
    auth_fail: boolean;
}
type AccountReadings = Pick<AccountUsage, "account" | "config_dirs" | "identity"> & {
    auth_fail?: boolean;
    readings: readonly ObservedReading[];
};
/** One account's usage from its readings: a fresh poller is the record; others lend or raise windows. */
declare function mergeAccountReadings(input: AccountReadings, now: number): AccountUsage;

export { type AccountProfile as A, DEFAULT_LABEL as D, type LoginState as L, type OAuthUsageOptions as O, POLL_SESSION_ID as P, type RefusedReason as R, type UsageReading as U, type AccountReadings as a, type AccountUsage as b, type AccountWindow as c, type ObservedReading as d, POLL_SOURCE as e, type UsageWindow as f, accountLabel as g, parseUsageReading as h, loginStateFromCredentials as l, mergeAccountReadings as m, needsRefresh as n, parseObservedReading as p, usageFromOAuthResponse as u };
