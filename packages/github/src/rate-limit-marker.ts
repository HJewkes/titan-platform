import { classifyGitHubFailure, type GitHubFailureInput } from "./github-failure.js";

/** The headers `classifyGitHubFailure` reads, and so the only ones a marker carries. */
const LIMIT_HEADERS = ["retry-after", "x-ratelimit-remaining", "x-ratelimit-reset", "x-ratelimit-resource"] as const;

const MARKER = /\[gh-rate-limit ([^\]]{1,400})\]/;
const FIELD_VALUE = /^[A-Za-z0-9_.-]{1,40}$/;

/** What a marker hands a caller who sees only an error's text: enough to classify the failure again on its own clock. */
export interface RateLimitFacts {
  status: number;
  method: string;
  headers: Readonly<Record<string, string>>;
}

/**
 * A failed call's answer as a `[gh-rate-limit …]` text marker, or "" when `classifyGitHubFailure` does not call it a
 * limit. Step errors reach their runner as strings, so the marker is what lets a caller tell a limit from a refusal.
 */
export function rateLimitMarker(status: number | undefined, method: string, headers: ReadonlyMap<string, string>, message: string): string {
  if (status === undefined) return "";
  const picked = Object.fromEntries(LIMIT_HEADERS.flatMap((name) => {
    const value = headers.get(name)?.trim();
    return value !== undefined && FIELD_VALUE.test(value) ? [[name, value]] : [];
  }));
  const input: GitHubFailureInput = { status, headers: picked, message, method, streak: 0, now: 0 };
  if (status < 400 || status >= 500 || classifyGitHubFailure(input).kind !== "unavailable") return "";
  const fields = [`status=${status}`, `method=${FIELD_VALUE.test(method) ? method.toUpperCase() : "UNKNOWN"}`, ...Object.entries(picked).map(([name, value]) => `${name}=${value}`)];
  return `[gh-rate-limit ${fields.join(" ")}]`;
}

/** The facts of the first marker in `text`, or undefined when it carries none. */
export function parseRateLimitMarker(text: string): RateLimitFacts | undefined {
  const body = MARKER.exec(text)?.[1];
  if (body === undefined) return undefined;
  const fields = new Map(body.split(" ").flatMap((field) => {
    const [name, value] = field.split("=");
    return name && value && FIELD_VALUE.test(value) ? [[name, value] as const] : [];
  }));
  const status = Number(fields.get("status"));
  const method = fields.get("method");
  if (!Number.isInteger(status) || method === undefined) return undefined;
  const headers = Object.fromEntries(LIMIT_HEADERS.flatMap((name) => (fields.has(name) ? [[name, fields.get(name)!]] : [])));
  return { status, method, headers };
}
