import { A as AccountProfile, L as LoginState, U as UsageReading, R as RefusedReason } from './profile.js';
import 'zod';

declare const CONFIG_DIRS_ENV = "CLAUDE_CONFIG_DIRS";
declare const PROFILE_ROOT_ENV = "CLAUDE_PROFILE_ROOT";
interface DiscoverOptions {
    home?: string;
    env?: Readonly<Record<string, string | undefined>>;
}
declare function discoverProfiles(options?: DiscoverOptions): AccountProfile[];

declare const CREDENTIALS_FILE = ".credentials.json";
declare const MAX_CREDENTIALS_BYTES: number;
interface ReadLoginOptions {
    now?: number;
    uid?: number;
}
declare function readLoginState(configDir: string, options?: ReadLoginOptions): LoginState;

declare const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
declare const OAUTH_BETA = "oauth-2025-04-20";
declare const DEFAULT_TIMEOUT_MS = 10000;
declare const MAX_RESPONSE_BYTES: number;
declare const EXPIRY_MARGIN_MS = 60000;
type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
type PollFailureKind = "expired" | "missing" | "refused" | "network" | "malformed" | "io" | "backoff" | `http-${number}`;
type PollFailure = {
    ok: false;
    failure: "refused";
    reason: RefusedReason;
} | {
    ok: false;
    failure: Exclude<PollFailureKind, "refused">;
};
type PollResult = {
    ok: true;
    reading: UsageReading;
} | PollFailure;
interface PollOptions {
    fetch?: FetchLike;
    now?: number;
    uid?: number;
    timeoutMs?: number;
}
interface PollAllOptions extends PollOptions {
    profiles?: readonly AccountProfile[];
    discover?: DiscoverOptions;
}
interface PollAllEntry {
    label: string;
    result: PollResult;
    file?: string;
    writeError?: Error;
    backoffUntil?: number;
}
declare function pollUsage(profile: AccountProfile, options: PollOptions): Promise<PollResult>;
declare function pollAll(options: PollAllOptions): Promise<PollAllEntry[]>;

declare const REFRESH_LOCK = ".oauth_refresh.lock";

declare const DEPOSIT_ASKER = "anthropic-account";
type RefreshFailureKind = "login-required" | "unrecognized-format" | "write-conflict" | "write-failed" | "network" | "malformed" | "io" | `http-${number}`;
interface RefreshFailureDeposit {
    depositId: string;
    asker: string;
    kind: "do";
    door: "two-way";
    summary: string;
    context: string;
}
declare function refreshFailureDeposit(label: string, failure: RefreshFailureKind, now: number): RefreshFailureDeposit;

declare const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
declare const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
declare const DEFAULT_REFRESH_SCOPES: readonly string[];
declare const MAX_REFRESH_TIMEOUT_MS = 30000;
declare const DEFAULT_REFRESH_TIMEOUT_MS = 10000;
declare const MAX_TOKEN_RESPONSE_BYTES: number;
type RefreshResult = {
    status: "fresh";
} | {
    status: "refreshed";
    expiresAt: number;
} | {
    status: "refreshed-elsewhere";
} | {
    status: "locked";
} | {
    status: "skipped";
    reason: "missing" | "not-refreshable" | RefusedReason;
} | {
    status: "failed";
    failure: RefreshFailureKind;
    deposited: boolean;
};
interface RefreshOptions {
    fetch: FetchLike;
    marginMs: number;
    now?: number;
    uid?: number;
    timeoutMs?: number;
    onFailure?: (deposit: RefreshFailureDeposit) => void | Promise<void>;
}
declare function refreshIfNeeded(profile: AccountProfile, options: RefreshOptions): Promise<RefreshResult>;

declare const USAGE_FILE = "usage-poll.json";
declare const MAX_READING_BYTES: number;
interface UsageFileRead {
    reading: UsageReading;
    file: string;
    ageSeconds: number;
}
declare function sessionsDir(configDir: string): string;
declare function usageFilePath(configDir: string): string;
interface ReadUsageOptions {
    now?: number;
    windows?: readonly string[];
}
declare function readUsage(configDir: string, options?: ReadUsageOptions): UsageFileRead | null;
declare function writeReading(configDir: string, reading: UsageReading): string;

export { CONFIG_DIRS_ENV, CREDENTIALS_FILE, DEFAULT_REFRESH_SCOPES, DEFAULT_REFRESH_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, DEPOSIT_ASKER, type DiscoverOptions, EXPIRY_MARGIN_MS, type FetchLike, MAX_CREDENTIALS_BYTES, MAX_READING_BYTES, MAX_REFRESH_TIMEOUT_MS, MAX_RESPONSE_BYTES, MAX_TOKEN_RESPONSE_BYTES, OAUTH_BETA, OAUTH_CLIENT_ID, PROFILE_ROOT_ENV, type PollAllEntry, type PollAllOptions, type PollFailure, type PollFailureKind, type PollOptions, type PollResult, REFRESH_LOCK, type ReadLoginOptions, type ReadUsageOptions, type RefreshFailureDeposit, type RefreshFailureKind, type RefreshOptions, type RefreshResult, TOKEN_URL, USAGE_FILE, USAGE_URL, type UsageFileRead, discoverProfiles, pollAll, pollUsage, readLoginState, readUsage, refreshFailureDeposit, refreshIfNeeded, sessionsDir, usageFilePath, writeReading };

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
