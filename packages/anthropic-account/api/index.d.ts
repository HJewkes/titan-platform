export { A as AccountProfile, D as DEFAULT_LABEL, L as LoginState, O as OAuthUsageOptions, P as POLL_SESSION_ID, a as POLL_SOURCE, R as RefusedReason, U as UsageReading, b as UsageWindow, c as accountLabel, l as loginStateFromCredentials, n as needsRefresh, p as parseUsageReading, u as usageFromOAuthResponse } from './profile.js';
import 'zod';

declare const REDACTED = "[REDACTED]";
declare function redactSecrets(value: string): string;
declare function redactSecrets(value: Error): Error;

export { REDACTED, redactSecrets };

// ./dist/profile.d.ts
import { z } from 'zod';

declare const windowSchema: z.ZodObject<{
    used_percentage: z.ZodNumber;
    resets_at: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
declare const usageReadingSchema: z.ZodObject<{
    session_id: z.ZodString;
    written_at: z.ZodNumber;
    rate_limits: z.ZodRecord<z.ZodString, z.ZodObject<{
        used_percentage: z.ZodNumber;
        resets_at: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
    source: z.ZodOptional<z.ZodString>;
    account: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
type UsageWindow = z.infer<typeof windowSchema>;
type UsageReading = z.infer<typeof usageReadingSchema>;
declare const POLL_SESSION_ID = "usage-poll";
declare const POLL_SOURCE = "oauth-usage";
declare function parseUsageReading(input: unknown): UsageReading | null;
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

export { type AccountProfile as A, DEFAULT_LABEL as D, type LoginState as L, type OAuthUsageOptions as O, POLL_SESSION_ID as P, type RefusedReason as R, type UsageReading as U, POLL_SOURCE as a, type UsageWindow as b, accountLabel as c, loginStateFromCredentials as l, needsRefresh as n, parseUsageReading as p, usageFromOAuthResponse as u };
