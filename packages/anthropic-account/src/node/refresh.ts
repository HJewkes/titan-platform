import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { loginStateFromCredentials, needsRefresh, type RefusedReason } from "../login.js";
import type { AccountProfile } from "../profile.js";
import {
  acquireRefreshLock,
  jsonFormatOf,
  readCredentialsText,
  replaceCredentials,
  unchangedSince,
  type JsonFormat,
} from "./credentials-write.js";
import { currentUid } from "./login.js";
import type { FetchLike } from "./poll.js";
import { refreshFailureDeposit, type RefreshFailureDeposit, type RefreshFailureKind } from "./refresh-deposit.js";

// Claude Code 2.1.x's production OAuth config: its TOKEN_URL and CLIENT_ID, and the scopes
// its refresh asks for when the stored login names no client.
export const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
export const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
export const DEFAULT_REFRESH_SCOPES: readonly string[] = [
  "user:profile",
  "user:inference",
  "user:sessions:claude_code",
  "user:mcp_servers",
  "user:file_upload",
  "user:plugins",
];
const PROJECT_SCOPES: readonly string[] = ["user:projects:read", "user:projects:write"];
const INFERENCE_SCOPE = "user:inference";

// Claude Code treats a refresh lock older than 60 s as stale, so a request may hold it for
// half that at most.
export const MAX_REFRESH_TIMEOUT_MS = 30_000;
export const DEFAULT_REFRESH_TIMEOUT_MS = 10_000;
export const MAX_TOKEN_RESPONSE_BYTES = 64 * 1024;
// After the exchange, how often a store that lost a race re-reads and retries, and how long
// it waits for a file caught mid-write.
const STORE_ATTEMPTS = 4;
const STORE_RETRY_MS = 100;

// RFC 6750's b64token: anything else, such as a CR or LF, has no business in a token.
const TOKEN_SHAPE = /^[A-Za-z0-9._~+/=-]{1,4096}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const YEAR_SECONDS = 366 * 24 * 3600;

const storedSchema = z.object({
  claudeAiOauth: z.object({
    refreshToken: z.string().regex(TOKEN_SHAPE),
    clientId: z.string().regex(UUID).optional(),
    scopes: z.array(z.string()).optional(),
    subscriptionType: z.string().nullable().optional(),
  }),
});

const tokenResponseSchema = z.object({
  access_token: z.string().regex(TOKEN_SHAPE),
  expires_in: z.number().int().positive().max(YEAR_SECONDS),
  refresh_token: z.string().regex(TOKEN_SHAPE).optional(),
  refresh_token_expires_in: z.number().int().positive().max(10 * YEAR_SECONDS).optional(),
});

type TokenResponse = z.infer<typeof tokenResponseSchema>;
type StoredOAuth = z.infer<typeof storedSchema>["claudeAiOauth"];

export type RefreshResult =
  | { status: "fresh" }
  | { status: "refreshed"; expiresAt: number }
  // Another writer replaced the login (its refresh token) after it was read; its version stands.
  | { status: "refreshed-elsewhere" }
  // Claude Code, or another refresher, holds the refresh lock.
  | { status: "locked" }
  | { status: "skipped"; reason: "missing" | "not-refreshable" | RefusedReason }
  | { status: "failed"; failure: RefreshFailureKind; deposited: boolean };

export interface RefreshOptions {
  fetch: FetchLike;
  // Refresh when the access token expires within this many ms.
  marginMs: number;
  now?: number;
  // The uid that must own the credentials file. Defaults to this process's.
  uid?: number;
  timeoutMs?: number;
  // Called once per failed refresh. The depositId is stable per profile per UTC day, one for
  // failures a retry may clear and one for those that need a new login, so the owner-queue
  // spool keeps at most two items however often the poller retries.
  onFailure?: (deposit: RefreshFailureDeposit) => void | Promise<void>;
}

interface Settings {
  fetch: FetchLike;
  marginMs: number;
  now: number;
  uid: number;
  timeoutMs: number;
}

// One version of the file: its exact text, its parse and its layout.
interface CredentialsBase {
  text: string;
  credentials: Record<string, unknown>;
  format: JsonFormat;
}

interface RefreshPlan extends CredentialsBase {
  refreshToken: string;
  body: string;
}

type Failed = Extract<RefreshResult, { status: "failed" }>;

function failed(failure: RefreshFailureKind): Failed {
  return { status: "failed", failure, deposited: false };
}

function skipped(reason: "missing" | "not-refreshable" | RefusedReason): RefreshResult {
  return { status: "skipped", reason };
}

function settingsFrom(options: RefreshOptions): Settings {
  const now = options.now ?? Date.now();
  const timeoutMs = options.timeoutMs ?? DEFAULT_REFRESH_TIMEOUT_MS;
  if (!Number.isFinite(now)) throw new RangeError("now must be a finite epoch-ms time");
  if (!Number.isFinite(options.marginMs) || options.marginMs < 0) {
    throw new RangeError("marginMs must be a finite non-negative number");
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_REFRESH_TIMEOUT_MS) {
    throw new RangeError(`timeoutMs must be positive and at most ${MAX_REFRESH_TIMEOUT_MS}`);
  }
  return { fetch: options.fetch, marginMs: options.marginMs, now, uid: options.uid ?? currentUid(), timeoutMs };
}

// JSON.parse's SyntaxError quotes the input, so it is dropped, never wrapped.
function parseObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// Mirrors Claude Code: a login with no client id asks for the default scopes plus any
// project scopes it already holds; one with a client id asks for exactly what it holds.
function scopesFor(oauth: StoredOAuth): string[] {
  const stored = oauth.scopes ?? [];
  if (oauth.clientId !== undefined) return stored.length > 0 ? stored : [...DEFAULT_REFRESH_SCOPES];
  return [...new Set([...DEFAULT_REFRESH_SCOPES, ...stored.filter((scope) => PROJECT_SCOPES.includes(scope))])];
}

function requestBody(oauth: StoredOAuth): string {
  return JSON.stringify({
    grant_type: "refresh_token",
    refresh_token: oauth.refreshToken,
    client_id: oauth.clientId ?? OAUTH_CLIENT_ID,
    scope: scopesFor(oauth).join(" "),
  });
}

// Everything that could stop the new tokens being stored is checked before the refresh
// token is spent, since a rotated refresh token that is never written logs the profile out.
function planFrom(text: string, credentials: Record<string, unknown>): RefreshResult | { plan: RefreshPlan } {
  const stored = storedSchema.safeParse(credentials);
  if (!stored.success) return failed("login-required");
  const oauth = stored.data.claudeAiOauth;
  if (!(oauth.scopes ?? []).includes(INFERENCE_SCOPE) && !oauth.subscriptionType) return skipped("not-refreshable");
  const format = jsonFormatOf(text, credentials);
  if (format === null) return failed("unrecognized-format");
  return { plan: { text, credentials, format, refreshToken: oauth.refreshToken, body: requestBody(oauth) } };
}

function decide(configDir: string, settings: Settings): RefreshResult | { plan: RefreshPlan } {
  const read = readCredentialsText(configDir, settings.uid);
  if (read.status !== "text") return skipped(read.status === "missing" ? "missing" : read.reason);
  const credentials = parseObject(read.text);
  if (credentials === null) return skipped("malformed");
  const state = loginStateFromCredentials(credentials, settings.now);
  if (state.status === "missing") return skipped("missing");
  if (state.status === "refused") return skipped(state.reason);
  if (!needsRefresh(state, settings.now, settings.marginMs)) return { status: "fresh" };
  if (!state.canRefresh) return failed("login-required");
  return planFrom(read.text, credentials);
}

async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

async function readCapped(response: Response): Promise<string | null> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
    total += chunk.value.byteLength;
    if (total > MAX_TOKEN_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(chunk.value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function wasRedirected(response: Response): boolean {
  return response.redirected || (response.url !== "" && response.url !== TOKEN_URL);
}

// An error body, which may echo the refresh token, is cancelled unread. Claude Code accepts
// only a 200.
async function tokensFrom(response: Response): Promise<{ tokens: TokenResponse } | Failed> {
  if (wasRedirected(response) || !Number.isInteger(response.status)) {
    await discard(response);
    return failed("network");
  }
  if (response.status !== 200) {
    await discard(response);
    return failed(`http-${response.status}`);
  }
  const text = await readCapped(response);
  const parsed = tokenResponseSchema.safeParse(text === null ? null : parseObject(text));
  return parsed.success ? { tokens: parsed.data } : failed("malformed");
}

// The refresh token goes only in this body, only to TOKEN_URL, and never follows a redirect.
async function exchange(body: string, settings: Settings): Promise<{ tokens: TokenResponse } | Failed> {
  try {
    const response = await settings.fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body,
      redirect: "error",
      signal: AbortSignal.timeout(settings.timeoutMs),
    });
    return await tokensFrom(response);
  } catch {
    return failed("network");
  }
}

// Spread keeps every key in its place, so only the refreshed values differ from the base.
function serialize(base: CredentialsBase, tokens: TokenResponse, now: number): { text: string; expiresAt: number } {
  const oauth = base.credentials.claudeAiOauth as Record<string, unknown>;
  const expiresAt = now + tokens.expires_in * 1000;
  const updated: Record<string, unknown> = { ...oauth, accessToken: tokens.access_token, expiresAt };
  if (tokens.refresh_token !== undefined) updated.refreshToken = tokens.refresh_token;
  if (tokens.refresh_token_expires_in !== undefined) {
    updated.refreshTokenExpiresAt = now + tokens.refresh_token_expires_in * 1000;
  }
  const text = JSON.stringify({ ...base.credentials, claudeAiOauth: updated }, null, base.format.indent);
  return { text: `${text}${base.format.trailer}`, expiresAt };
}

function storedRefreshToken(credentials: Record<string, unknown>): string | undefined {
  const parsed = storedSchema.safeParse(credentials);
  return parsed.success ? parsed.data.claudeAiOauth.refreshToken : undefined;
}

// The file changed under a spent refresh token. The login is the refresh token, not the
// bytes: while the file still holds the token just spent, any other change (a key written
// by a session, a write caught half-done) is merged under, never a reason to drop the new
// tokens, which may hold the only live refresh token. Only a different login, or a logout,
// is yielded to.
function rebase(configDir: string, uid: number, spent: string): CredentialsBase | "yield" | "retry" {
  const read = readCredentialsText(configDir, uid);
  if (read.status === "missing") return "yield";
  if (read.status !== "text") return "retry";
  const credentials = parseObject(read.text);
  if (credentials === null) return "retry";
  if (storedRefreshToken(credentials) !== spent) return "yield";
  const format = jsonFormatOf(read.text, credentials);
  return format === null ? "retry" : { text: read.text, credentials, format };
}

async function storeOrRetry(configDir: string, plan: RefreshPlan, tokens: TokenResponse, settings: Settings): Promise<RefreshResult> {
  let base: CredentialsBase = plan;
  for (let attempt = 1; attempt <= STORE_ATTEMPTS; attempt++) {
    const next = serialize(base, tokens, settings.now);
    if (replaceCredentials(configDir, settings.uid, base.text, next.text) === "written") {
      return { status: "refreshed", expiresAt: next.expiresAt };
    }
    const current = rebase(configDir, settings.uid, plan.refreshToken);
    if (current === "yield") return { status: "refreshed-elsewhere" };
    if (current === "retry") await delay(STORE_RETRY_MS);
    else base = current;
  }
  return failed("write-conflict");
}

// A rotated refresh token has replaced the stored one at the server, so a write that throws
// leaves a login a retry cannot renew. Without a rotation the stored token still works.
async function store(configDir: string, plan: RefreshPlan, tokens: TokenResponse, settings: Settings): Promise<RefreshResult> {
  try {
    return await storeOrRetry(configDir, plan, tokens, settings);
  } catch {
    return failed(tokens.refresh_token === undefined ? "io" : "write-failed");
  }
}

async function refreshLocked(configDir: string, plan: RefreshPlan, settings: Settings): Promise<RefreshResult> {
  if (!unchangedSince(configDir, settings.uid, plan.text)) return { status: "refreshed-elsewhere" };
  const exchanged = await exchange(plan.body, settings);
  if (!("tokens" in exchanged)) return exchanged;
  return store(configDir, plan, exchanged.tokens, settings);
}

// A filesystem error's message is not kept, so nothing it quotes can travel further.
async function attempt(configDir: string, settings: Settings): Promise<RefreshResult> {
  try {
    const decided = decide(configDir, settings);
    if (!("plan" in decided)) return decided;
    const release = acquireRefreshLock(configDir);
    if (release === null) return { status: "locked" };
    try {
      return await refreshLocked(configDir, decided.plan, settings);
    } finally {
      release();
    }
  } catch {
    return failed("io");
  }
}

// A deposit that cannot be filed does not change the outcome; `deposited` says so.
async function report(label: string, result: Failed, options: RefreshOptions, now: number): Promise<Failed> {
  if (options.onFailure === undefined) return result;
  try {
    await options.onFailure(refreshFailureDeposit(label, result.failure, now));
    return { ...result, deposited: true };
  } catch {
    return result;
  }
}

// Refreshes the profile's OAuth access token when needsRefresh says it is due, under Claude
// Code's own refresh lock, and replaces the credentials file atomically. It never logs, and
// never throws for anything the file, the lock or the server does: each outcome is a value
// with no message. Only a bad `now`, `marginMs` or `timeoutMs` throws.
export async function refreshIfNeeded(profile: AccountProfile, options: RefreshOptions): Promise<RefreshResult> {
  const settings = settingsFrom(options);
  const result = await attempt(profile.configDir, settings);
  return result.status === "failed" ? report(profile.label, result, options, settings.now) : result;
}
