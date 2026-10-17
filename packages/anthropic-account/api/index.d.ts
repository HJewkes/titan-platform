import { z } from 'zod';
export { REDACTED, redactSecrets } from '@titan-design/agent-protocol/redaction';

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

export { type AccountProfile, DEFAULT_LABEL, type LoginState, type OAuthUsageOptions, POLL_SESSION_ID, POLL_SOURCE, type RefusedReason, type UsageReading, type UsageWindow, accountLabel, loginStateFromCredentials, needsRefresh, parseUsageReading, usageFromOAuthResponse };
