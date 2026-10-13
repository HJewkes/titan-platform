import { createPrivateKey, createSign } from "node:crypto";
import { rateBudget } from "./budget.js";
import { execGh, type GhExec } from "./exec.js";
import { GitHubRequestError, octokitClient, type OctokitClientOptions } from "./octokit-client.js";
import { GitHubInputError } from "./validate.js";
import { parseIncluded } from "./rest.js";
import { redact, redactStreams } from "./redact.js";

export interface AppCredentials {
  appId: number;
  installationId: number;
  privateKeyPem: string;
  /** Epoch milliseconds; injected so a test controls expiry. */
  now: () => number;
}

export interface InstallationToken {
  token: string;
  /** Epoch milliseconds. */
  expiresAtMs: number;
}

const JWT_BACKDATE_S = 60;
const JWT_LIFETIME_S = 9 * 60;

const base64url = (data: Buffer | string): string => Buffer.from(data).toString("base64url");

/** An RS256 JWT for `iss = appId`: issued 60 s in the past for clock skew, valid under GitHub's 10 minute ceiling. */
export function signAppJwt(appId: number, privateKeyPem: string, nowMs: number): string {
  const iat = Math.floor(nowMs / 1000) - JWT_BACKDATE_S;
  const unsigned = `${base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64url(JSON.stringify({ iat, exp: iat + JWT_BACKDATE_S + JWT_LIFETIME_S, iss: String(appId) }))}`;
  try {
    if (createPrivateKey(privateKeyPem).asymmetricKeyType !== "rsa") throw new Error("not RSA");
    return `${unsigned}.${base64url(createSign("RSA-SHA256").update(unsigned).sign(privateKeyPem))}`;
  } catch {
    // The node error can quote key material, so none of it is carried over.
    throw new GitHubInputError("privateKeyPem", "[redacted]", "not a usable RSA private key in PEM form");
  }
}

/** Exchanges a freshly signed App JWT for an installation token; the JWT reaches `gh` as `GH_TOKEN` for this call only. */
export async function appInstallationToken(credentials: AppCredentials, exec: GhExec = execGh): Promise<InstallationToken> {
  const { installationId } = credentials;
  const { jwt, nowMs, secrets } = signedExchange(credentials);
  const args = ["api", "-i", "-X", "POST", `app/installations/${installationId}/access_tokens`];
  const result = await exec(args, undefined, { env: { GH_TOKEN: jwt } }).catch((error: unknown) => {
    throw new Error(redact(`installation token exchange could not run: ${error instanceof Error ? error.message : String(error)}`, secrets));
  });
  const response = parseIncluded(result.stdout);
  if (result.code !== 0 || !response || response.status >= 400) {
    // Stdout may hold a token the call just minted, so only stderr is echoed, and any token in it is redacted too.
    const [, stderr] = redactStreams(result.stdout, result.stderr, [...secrets, ...tokensIn(result.stdout), ...tokensIn(result.stderr)]);
    const detail = stderr.trim();
    throw new Error(`installation token exchange failed (${result.code}${response ? `, HTTP ${response.status}` : ""}): ${detail}`);
  }
  return readToken(response.body, nowMs, secrets);
}

/** The same exchange over Octokit, with the JWT as this one client's bearer token; no `gh` process and no child env. */
export async function appInstallationTokenOverHttp(credentials: AppCredentials, clientOptions: Omit<OctokitClientOptions, "token" | "reauthOn401"> = {}): Promise<InstallationToken> {
  const { jwt, nowMs, secrets } = signedExchange(credentials);
  const client = octokitClient({ throttleId: "app-jwt", budget: rateBudget(), ...clientOptions, token: async () => jwt, reauthOn401: false });
  let data: unknown;
  try {
    ({ data } = await client.request("POST /app/installations/{installation_id}/access_tokens", { installation_id: credentials.installationId }));
  } catch (error) {
    const status = error instanceof GitHubRequestError ? error.status : undefined;
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(redact(`installation token exchange failed${status === undefined ? "" : ` (HTTP ${status})`}: ${detail}`, [...secrets, ...tokensIn(detail)]));
  }
  return tokenOf(typeof data === "object" && data !== null ? data : {}, nowMs, secrets);
}

function signedExchange({ appId, installationId, privateKeyPem, now }: AppCredentials): { jwt: string; nowMs: number; secrets: string[] } {
  for (const [field, value] of [["appId", appId], ["installationId", installationId]] as const) {
    if (!Number.isInteger(value) || value <= 0) throw new GitHubInputError(field, value, "expected a positive integer");
  }
  const nowMs = now();
  const jwt = signAppJwt(appId, privateKeyPem, nowMs);
  return { jwt, nowMs, secrets: [jwt, privateKeyPem] };
}

function tokensIn(text: string): string[] {
  return [...text.matchAll(/"token"\s*:\s*"([^"]+)"/g)].map((match) => match[1]!);
}

interface TokenBody {
  token?: unknown;
  expires_at?: unknown;
}

function readToken(body: string, nowMs: number, secrets: readonly string[]): InstallationToken {
  let parsed: TokenBody;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error("installation token exchange answered with a body that is not JSON");
  }
  return tokenOf(parsed, nowMs, secrets);
}

function tokenOf(parsed: TokenBody, nowMs: number, secrets: readonly string[]): InstallationToken {
  const expiresAtMs = typeof parsed.expires_at === "string" ? Date.parse(parsed.expires_at) : Number.NaN;
  if (typeof parsed.token !== "string" || parsed.token === "" || Number.isNaN(expiresAtMs)) throw new Error("installation token exchange answered without a token and expiry");
  if (expiresAtMs <= nowMs) throw new Error(redact("installation token exchange answered with a token that is already expired", [...secrets, parsed.token]));
  return { token: parsed.token, expiresAtMs };
}
