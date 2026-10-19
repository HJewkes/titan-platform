export type CallClass = "core-read" | "graphql" | "mutation";
export type ResetSource = "retry-after" | "x-ratelimit-reset" | "backoff";

export interface GitHubFailureInput {
  /** Absent for a network failure. */
  status?: number;
  /** Header names lower-cased. */
  headers: Readonly<Record<string, string | undefined>>;
  /** Redacted message; Octokit puts GitHub's `message` in it. */
  message: string;
  method: string;
  networkError?: boolean;
  /** True for `POST /graphql`, whose queries are reads against their own bucket. */
  graphql?: boolean;
  /** Consecutive unavailable answers already seen for this (identity, call class). */
  streak: number;
  /** Epoch milliseconds. */
  now: number;
}

export type GitHubFailure =
  | { kind: "ok" }
  | { kind: "unavailable"; resetAt: number; source: ResetSource; bucket: string; callClass: CallClass; reason?: string }
  | { kind: "unknown" }
  | { kind: "auth" }
  | { kind: "error" };

const BASE_WAIT_MS = 60_000;
const MAX_BACKOFF_MS = 15 * 60_000;
const MAX_HEADER_WAIT_MS = 61 * 60_000;

/** One list so a new GitHub phrasing is a one-line change. */
export const RATE_LIMIT_PHRASES: readonly RegExp[] = [/\brate[- ]limit(?:ed)?\b/i, /\babuse\b/i, /\bspam(?:med)?\b/i];

export function nextResetAt(now: number, streak: number): number {
  return now + Math.min(BASE_WAIT_MS * 2 ** Math.max(0, streak), MAX_BACKOFF_MS);
}

function callClassOf(input: GitHubFailureInput): CallClass {
  if (input.graphql) return "graphql";
  const method = input.method.toUpperCase();
  return method === "GET" || method === "HEAD" ? "core-read" : "mutation";
}

function defaultBucket(callClass: CallClass): string {
  return callClass === "graphql" ? "graphql" : "core";
}

function seconds(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value.trim())) return undefined;
  return Number(value);
}

function headerReset(input: GitHubFailureInput): { at: number; source: ResetSource } | undefined {
  const retryAfter = seconds(input.headers["retry-after"]);
  if (retryAfter !== undefined) return { at: input.now + retryAfter * 1000, source: "retry-after" };
  const reset = seconds(input.headers["x-ratelimit-reset"]);
  if (reset !== undefined && reset * 1000 > input.now) return { at: reset * 1000, source: "x-ratelimit-reset" };
  return undefined;
}

function unavailable(input: GitHubFailureInput): GitHubFailure {
  const callClass = callClassOf(input);
  const bucket = input.headers["x-ratelimit-resource"] ?? defaultBucket(callClass);
  const header = headerReset(input);
  if (!header) return { kind: "unavailable", resetAt: nextResetAt(input.now, input.streak), source: "backoff", bucket, callClass };
  const cap = input.now + MAX_HEADER_WAIT_MS;
  if (header.at <= cap) return { kind: "unavailable", resetAt: header.at, source: header.source, bucket, callClass };
  return { kind: "unavailable", resetAt: cap, source: header.source, bucket, callClass, reason: `${header.source} beyond 61 min, clamped` };
}

function namesLimit(message: string): boolean {
  return RATE_LIMIT_PHRASES.some((phrase) => phrase.test(message));
}

function isLimit403(input: GitHubFailureInput): boolean {
  const { headers, message } = input;
  return seconds(headers["retry-after"]) !== undefined || headers["x-ratelimit-remaining"]?.trim() === "0" || namesLimit(message);
}

function serverSide(input: GitHubFailureInput): GitHubFailure {
  return callClassOf(input) === "mutation" ? { kind: "unknown" } : unavailable(input);
}

export function classifyGitHubFailure(input: GitHubFailureInput): GitHubFailure {
  const { status } = input;
  if (input.networkError || status === undefined) return serverSide(input);
  if (status < 400) return { kind: "ok" };
  if (status === 401) return { kind: "auth" };
  if (status === 429) return unavailable(input);
  if (status >= 500) return serverSide(input);
  if (status === 403 && isLimit403(input)) return unavailable(input);
  if (status === 422 && namesLimit(input.message)) return unavailable(input);
  return { kind: "error" };
}
