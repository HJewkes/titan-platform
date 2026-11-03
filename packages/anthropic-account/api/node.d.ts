import { A as AccountProfile, b as AccountUsage, L as LoginState, U as UsageReading, R as RefusedReason, d as ObservedReading } from './merge.js';
import 'zod';

declare const CONFIG_DIRS_ENV = "CLAUDE_CONFIG_DIRS";
declare const PROFILE_ROOT_ENV = "CLAUDE_PROFILE_ROOT";
interface DiscoverOptions {
    home?: string;
    env?: Readonly<Record<string, string | undefined>>;
}
declare function discoverProfiles(options?: DiscoverOptions): AccountProfile[];

interface ReadAccountsOptions extends DiscoverOptions {
    now?: number;
    /** The login a config dir bills; defaults to accountIdentity. */
    identify?: (configDir: string) => string | undefined;
    /** The uid that must own each credentials file. Defaults to this process's. */
    uid?: number;
    platform?: NodeJS.Platform;
}
/** One row per Anthropic login, every discovered profile included, each naming all its config dirs. */
declare function readAccounts(options?: ReadAccountsOptions): AccountUsage[];

/** A file's text, or undefined when it cannot be read. Injected so tests never touch a real login. */
type ReadText = (file: string) => string | undefined;
/**
 * CC-1289: the Anthropic login a config dir bills, `accountUuid/organizationUuid`, or undefined
 * when none can be read. Claude Code keeps the default dir's login in `~/.claude.json` when
 * CLAUDE_CONFIG_DIR is unset, so that file is read first and `<dir>/.claude.json` second.
 */
declare function accountIdentity(configDir: string, home?: string, read?: ReadText): string | undefined;

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
    pollerFirstSeconds?: number;
    dropReset?: boolean;
}
declare function readUsage(configDir: string, options?: ReadUsageOptions): UsageFileRead | null;
declare function readReadings(configDir: string): ObservedReading[];
declare function writeReading(configDir: string, reading: UsageReading): string;

export { CONFIG_DIRS_ENV, CREDENTIALS_FILE, DEFAULT_REFRESH_SCOPES, DEFAULT_REFRESH_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, DEPOSIT_ASKER, type DiscoverOptions, EXPIRY_MARGIN_MS, type FetchLike, MAX_CREDENTIALS_BYTES, MAX_READING_BYTES, MAX_REFRESH_TIMEOUT_MS, MAX_RESPONSE_BYTES, MAX_TOKEN_RESPONSE_BYTES, OAUTH_BETA, OAUTH_CLIENT_ID, PROFILE_ROOT_ENV, type PollAllEntry, type PollAllOptions, type PollFailure, type PollFailureKind, type PollOptions, type PollResult, REFRESH_LOCK, type ReadAccountsOptions, type ReadLoginOptions, type ReadText, type ReadUsageOptions, type RefreshFailureDeposit, type RefreshFailureKind, type RefreshOptions, type RefreshResult, TOKEN_URL, USAGE_FILE, USAGE_URL, type UsageFileRead, accountIdentity, discoverProfiles, pollAll, pollUsage, readAccounts, readLoginState, readReadings, readUsage, refreshFailureDeposit, refreshIfNeeded, sessionsDir, usageFilePath, writeReading };

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
