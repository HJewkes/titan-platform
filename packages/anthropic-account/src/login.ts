import { z } from "zod";
import { redactSecrets } from "./redact.js";

// Epoch milliseconds between 2001 and 5138. A seconds value falls below the range and a
// microseconds value above it, so a unit mix-up is refused as malformed instead of reading
// as long expired or as never expiring.
const epochMs = z.number().int().min(1e12).max(1e14);

// Token fields are checked for presence and type only; their values are never copied out.
const oauthSchema = z.object({
  accessToken: z.string().min(1),
  expiresAt: epochMs,
  refreshToken: z.string().min(1).optional(),
  refreshTokenExpiresAt: epochMs.nullable().optional(),
  subscriptionType: z.string().nullable().optional(),
  rateLimitTier: z.string().nullable().optional(),
});

export type RefusedReason = "malformed" | "mode-too-wide" | "foreign-owner" | "not-a-regular-file";

export type LoginState =
  | {
      status: "present";
      expiresAt: number;
      canRefresh: boolean;
      subscriptionType?: string;
      rateLimitTier?: string;
    }
  | { status: "expired"; expiresAt: number; canRefresh: boolean }
  | { status: "missing" }
  | { status: "refused"; reason: RefusedReason };

const LABEL = /^[A-Za-z0-9_.-]{1,64}$/;

// A plan label is copied into the state, so it must look like a label and survive
// redaction unchanged; anything token-shaped is dropped.
function safeLabel(value: string | null | undefined): string | undefined {
  if (typeof value !== "string" || !LABEL.test(value)) return undefined;
  return redactSecrets(value) === value ? value : undefined;
}

type OAuth = z.infer<typeof oauthSchema>;

function canRefresh(oauth: OAuth, now: number): boolean {
  if (oauth.refreshToken === undefined) return false;
  const until = oauth.refreshTokenExpiresAt;
  return until === undefined || until === null || until > now;
}

function stateFromOAuth(oauth: OAuth, now: number): LoginState {
  const refreshable = canRefresh(oauth, now);
  if (oauth.expiresAt <= now) return { status: "expired", expiresAt: oauth.expiresAt, canRefresh: refreshable };
  const state: LoginState = { status: "present", expiresAt: oauth.expiresAt, canRefresh: refreshable };
  const subscriptionType = safeLabel(oauth.subscriptionType);
  const rateLimitTier = safeLabel(oauth.rateLimitTier);
  if (subscriptionType !== undefined) state.subscriptionType = subscriptionType;
  if (rateLimitTier !== undefined) state.rateLimitTier = rateLimitTier;
  return state;
}

function readOAuthField(credentials: unknown): unknown {
  if (typeof credentials !== "object" || credentials === null) return undefined;
  if (!Object.hasOwn(credentials, "claudeAiOauth")) return undefined;
  return (credentials as Record<string, unknown>).claudeAiOauth;
}

function assertFiniteNow(now: number): void {
  if (!Number.isFinite(now)) throw new RangeError("now must be a finite epoch-ms time");
}

// Takes the parsed `.credentials.json` object and returns no token. The input never makes it
// throw: a hostile getter's exception, which could carry a token, is swallowed into
// `malformed`. Only a bad `now`, a caller bug, throws, with a fixed message.
export function loginStateFromCredentials(credentials: unknown, now: number): LoginState {
  assertFiniteNow(now);
  try {
    const oauth = readOAuthField(credentials);
    if (oauth === undefined || oauth === null) return { status: "missing" };
    const parsed = oauthSchema.safeParse(oauth);
    return parsed.success ? stateFromOAuth(parsed.data, now) : { status: "refused", reason: "malformed" };
  } catch {
    return { status: "refused", reason: "malformed" };
  }
}

// True when the access token expires within `marginMs` of `now`, and always for an expired
// state, whatever `now` the caller passes. A state with no expiry (missing, refused) never needs a refresh; it needs a login.
export function needsRefresh(state: LoginState, now: number, marginMs: number): boolean {
  assertFiniteNow(now);
  if (!Number.isFinite(marginMs) || marginMs < 0) throw new RangeError("marginMs must be a finite non-negative number");
  if (state.status === "expired") return true;
  if (state.status !== "present") return false;
  return state.expiresAt - now <= marginMs;
}
