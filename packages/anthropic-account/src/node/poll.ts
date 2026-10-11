import { z } from "zod";
import { loginStateFromCredentials, needsRefresh, type RefusedReason } from "../login.js";
import type { AccountProfile } from "../profile.js";
import { redactSecrets } from "../redact.js";
import { usageFromOAuthResponse, type UsageReading } from "../usage.js";
import { currentUid, readCredentialsFile, type CredentialsRead } from "./login.js";
import { clearBackoff, nextBackoff, readBackoff, writeBackoff, type PollBackoff } from "./poll-backoff.js";
import { discoverProfiles, type DiscoverOptions } from "./profiles.js";
import { redactedError } from "./redact-error.js";
import { writeReading } from "./usage-file.js";

export const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
// The beta flag Claude Code itself sends with an OAuth bearer token.
export const OAUTH_BETA = "oauth-2025-04-20";
export const DEFAULT_TIMEOUT_MS = 10_000;
export const MAX_RESPONSE_BYTES = 64 * 1024;
// A token this close to expiry could lapse in flight. It is reported expired, never refreshed.
export const EXPIRY_MARGIN_MS = 60_000;

// RFC 6750's b64token: anything else, such as a CR or LF, could split the header.
const TOKEN_SHAPE = /^[A-Za-z0-9._~+/=-]{1,4096}$/;

// The allowlist: every other key in the body is dropped before it is looked at. A known window
// in an unexpected shape fails the whole reading, so a good window never masks a bad one.
const responseWindow = z
  .object({ utilization: z.number().nonnegative(), resets_at: z.string().max(64).nullable() })
  .nullable()
  .optional();

const usageResponseSchema = z.object({
  five_hour: responseWindow,
  seven_day: responseWindow,
  seven_day_opus: responseWindow,
  seven_day_sonnet: responseWindow,
  seven_day_oauth_apps: responseWindow,
});

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

// `backoff` comes only from pollAll: an earlier 429 set a wait that has not run out, so no
// request was sent.
export type PollFailureKind =
  | "expired"
  | "missing"
  | "refused"
  | "network"
  | "malformed"
  | "io"
  | "backoff"
  | `http-${number}`;

export type PollFailure =
  | { ok: false; failure: "refused"; reason: RefusedReason }
  | { ok: false; failure: Exclude<PollFailureKind, "refused"> };

export type PollResult = { ok: true; reading: UsageReading } | PollFailure;

export interface PollOptions {
  // Receives the raw access token in the authorization header, so pass only a fetch you trust
  // with it: one that does not log, forward or persist request headers. Defaults to globalThis.fetch.
  fetch?: FetchLike;
  now?: number;
  // The uid that must own the credentials file. Defaults to this process's.
  uid?: number;
  timeoutMs?: number;
}

export interface PollAllOptions extends PollOptions {
  // Defaults to discoverProfiles(discover).
  profiles?: readonly AccountProfile[];
  discover?: DiscoverOptions;
}

export interface PollAllEntry {
  label: string;
  result: PollResult;
  file?: string;
  writeError?: Error;
  // Epoch seconds before which this profile is not polled again, after a 429.
  backoffUntil?: number;
}

function fail(failure: Exclude<PollFailureKind, "refused">): PollFailure {
  return { ok: false, failure };
}

function refused(reason: RefusedReason): PollFailure {
  return { ok: false, failure: "refused", reason };
}

function assertOptions(now: number, timeoutMs: number): void {
  if (!Number.isFinite(now)) throw new RangeError("now must be a finite epoch-ms time");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError("timeoutMs must be a finite positive number");
}

function tokenOf(credentials: unknown): string | null {
  try {
    const token = (credentials as { claudeAiOauth: { accessToken: unknown } }).claudeAiOauth.accessToken;
    return typeof token === "string" && TOKEN_SHAPE.test(token) ? token : null;
  } catch {
    return null;
  }
}

// Expiry is judged by the same rules readLoginState reports, and an expired or nearly
// expired token is a failure: the refresh token is never touched.
function accessFrom(read: CredentialsRead, now: number): { token: string } | PollFailure {
  if (read.status === "missing") return fail("missing");
  if (read.status === "refused") return refused(read.reason);
  const state = loginStateFromCredentials(read.credentials, now);
  if (state.status === "missing") return fail("missing");
  if (state.status === "refused") return refused(state.reason);
  if (needsRefresh(state, now, EXPIRY_MARGIN_MS)) return fail("expired");
  const token = tokenOf(read.credentials);
  return token === null ? refused("malformed") : { token };
}

// A filesystem error's message is not kept, so nothing it quotes can travel further.
function readAccess(configDir: string, uid: number, now: number): { token: string } | PollFailure {
  try {
    return accessFrom(readCredentialsFile(configDir, uid), now);
  } catch {
    return fail("io");
  }
}

// The token goes only in this header, only to USAGE_URL. A redirect fails the request, so
// the header is never resent to a Location the server names.
function request(token: string, fetch: FetchLike, timeoutMs: number): Promise<Response> {
  return fetch(USAGE_URL, {
    method: "GET",
    headers: { authorization: `Bearer ${token}`, "anthropic-beta": OAUTH_BETA, accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  });
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
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(chunk.value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// JSON.parse's SyntaxError quotes the input, so its message is dropped, never wrapped.
function readingFrom(text: string, account: string | undefined, writtenAt: number): PollResult {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return fail("malformed");
  }
  const parsed = usageResponseSchema.safeParse(body);
  const reading = parsed.success ? usageFromOAuthResponse(parsed.data, { writtenAt, account }) : null;
  return reading === null ? fail("malformed") : { ok: true, reading };
}

function wasRedirected(response: Response): boolean {
  return response.redirected || (response.url !== "" && response.url !== USAGE_URL);
}

// An error body is cancelled unread, so whatever it echoes never reaches this process's
// memory beyond the socket buffer.
async function resultFrom(response: Response, account: string | undefined, writtenAt: number): Promise<PollResult> {
  const status = response.status;
  if (wasRedirected(response) || !Number.isInteger(status)) {
    await discard(response);
    return fail("network");
  }
  if (status < 200 || status > 299) {
    await discard(response);
    return fail(`http-${status}`);
  }
  const text = await readCapped(response);
  return text === null ? fail("malformed") : readingFrom(text, account, writtenAt);
}

// writeReading refuses a token-shaped value, so a label that looks like one is left out.
function safeAccount(label: string): string | undefined {
  return label.length > 0 && redactSecrets(label) === label ? label : undefined;
}

// One read-only GET of the OAuth usage endpoint with the profile's stored access token. It
// never refreshes, never retries and never throws for anything the file or the server
// does: each failure is a value with no message. Only a bad `now` or `timeoutMs` throws.
export async function pollUsage(profile: AccountProfile, options: PollOptions): Promise<PollResult> {
  const now = options.now ?? Date.now();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  assertOptions(now, timeoutMs);
  const access = readAccess(profile.configDir, options.uid ?? currentUid(), now);
  if (!("token" in access)) return access;
  try {
    const response = await request(access.token, options.fetch ?? globalThis.fetch, timeoutMs);
    return await resultFrom(response, safeAccount(profile.label), Math.floor(now / 1000));
  } catch {
    return fail("network");
  }
}

// Best effort: a backoff that cannot be stored or cleared only means the next tick
// decides afresh, which is never worse than polling with no backoff at all.
function trackBackoff(configDir: string, result: PollResult, previous: PollBackoff | null, nowSeconds: number): number | undefined {
  try {
    if (result.ok) {
      // Unconditional, so a file readBackoff ignored as broken is removed too.
      clearBackoff(configDir);
      return undefined;
    }
    if (result.failure !== "http-429") return undefined;
    const next = nextBackoff(previous, nowSeconds);
    writeBackoff(configDir, next);
    return next.until;
  } catch {
    return undefined;
  }
}

async function pollAndWrite(profile: AccountProfile, options: PollOptions): Promise<PollAllEntry> {
  const now = options.now ?? Date.now();
  const nowSeconds = Math.floor(now / 1000);
  const backoff = readBackoff(profile.configDir, nowSeconds, options.uid ?? currentUid());
  if (backoff !== null && nowSeconds < backoff.until) {
    return { label: profile.label, result: fail("backoff"), backoffUntil: backoff.until };
  }
  const result = await pollUsage(profile, { ...options, now });
  const entry: PollAllEntry = { label: profile.label, result };
  const backoffUntil = trackBackoff(profile.configDir, result, backoff, nowSeconds);
  if (backoffUntil !== undefined) entry.backoffUntil = backoffUntil;
  if (!result.ok) return entry;
  try {
    entry.file = writeReading(profile.configDir, result.reading);
  } catch (error) {
    entry.writeError = redactedError(error, "writing the usage reading failed");
  }
  return entry;
}

function profilesFor(options: PollAllOptions): readonly AccountProfile[] {
  if (options.profiles !== undefined) return options.profiles;
  try {
    return discoverProfiles(options.discover);
  } catch (error) {
    throw redactedError(error, "discovering profiles failed");
  }
}

// Polls every profile at once and writes each successful reading to its usage-poll.json.
// One profile's failure, or its failed write, never stops another's. A 429 makes the
// profile wait out an exponential backoff before its next request; a success clears it.
export async function pollAll(options: PollAllOptions): Promise<PollAllEntry[]> {
  const profiles = profilesFor(options);
  return Promise.all(profiles.map((profile) => pollAndWrite(profile, options)));
}
