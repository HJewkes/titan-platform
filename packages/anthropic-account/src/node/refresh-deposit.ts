import { redactSecrets } from "../redact.js";

export const DEPOSIT_ASKER = "anthropic-account";

const LABEL = /^[A-Za-z0-9_.-]{1,64}$/;

export type RefreshFailureKind =
  | "login-required"
  | "unrecognized-format"
  | "write-conflict"
  | "network"
  | "malformed"
  | "io"
  | `http-${number}`;

// The shape of an owner-queue OwnerItemDeposit, so the caller can hand it to writeDeposit
// unchanged. It names the profile and the failure kind, never a token.
export interface RefreshFailureDeposit {
  depositId: string;
  asker: string;
  kind: "do";
  door: "two-way";
  summary: string;
  context: string;
}

const RELOGIN = "Log in again with Claude Code in this profile's config dir.";

const CONTEXTS: Partial<Record<RefreshFailureKind, string>> = {
  "login-required": `The stored refresh token is missing, expired or was refused. ${RELOGIN}`,
  "http-400": `The stored refresh token is missing, expired or was refused. ${RELOGIN}`,
  "http-401": `The stored refresh token is missing, expired or was refused. ${RELOGIN}`,
  "http-403": `The stored refresh token is missing, expired or was refused. ${RELOGIN}`,
  "unrecognized-format": `The credentials file is in a layout this refresher does not rewrite, so no refresh was sent. ${RELOGIN}`,
  "write-conflict": `The token was refreshed, but the credentials file kept changing and the new token could not be stored. If Claude Code reports a login error, ${RELOGIN}`,
};

const RETRY_CONTEXT = "The refresh will be retried on the next poll. If this repeats, check the network and the token endpoint.";

function depositLabel(label: string): string {
  return LABEL.test(label) && redactSecrets(label) === label ? label : "unlabelled";
}

export function refreshFailureDeposit(label: string, failure: RefreshFailureKind, now: number): RefreshFailureDeposit {
  const name = depositLabel(label);
  const day = new Date(now).toISOString().slice(0, 10);
  return {
    depositId: `token-refresh-${name}-${day}`,
    asker: DEPOSIT_ASKER,
    kind: "do",
    door: "two-way",
    summary: `Claude token refresh failed for profile ${name}: ${failure}`,
    context: CONTEXTS[failure] ?? RETRY_CONTEXT,
  };
}
