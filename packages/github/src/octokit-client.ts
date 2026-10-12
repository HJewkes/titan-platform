import { Octokit } from "@octokit/core";
import { retry } from "@octokit/plugin-retry";
import { throttling } from "@octokit/plugin-throttling";
import { execGh } from "./exec.js";
import { redact } from "./redact.js";

export type RateLane = "rest" | "graphql";

/** GitHub's own count for one lane, as its last answer's `x-ratelimit-*` headers put it. */
export interface RateWindow {
  limit: number;
  remaining: number;
  used: number;
  /** Epoch milliseconds. */
  resetAt: number;
}

/** A lane the throttle saw limited, and until when; a primary limit lasts to the window's reset, a secondary one to its retry-after. */
export interface Cooldown {
  lane: RateLane;
  class: "primary" | "secondary";
  /** Epoch milliseconds. */
  until: number;
}

export interface GatewayBudget {
  lanes: Partial<Record<RateLane, RateWindow>>;
  /** Only the cooldowns still running. */
  cooldowns: Cooldown[];
}

export interface OctokitClientOptions {
  /** Defaults to `gh auth token`, so the client speaks as the same login `gh` does. */
  token?: () => Promise<string>;
  /** Re-read the token once on a 401; off for a token that cannot change, such as an App JWT. Defaults to on. */
  reauthOn401?: boolean;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  /** Keys the throttle's limiters, so a second identity (an App installation) never waits behind the user's writes. */
  throttleId?: string;
}

export interface GitHubClient {
  request: Octokit["request"];
  budget(): GatewayBudget;
}

/** A failed call, rebuilt with only its status, headers and a redacted message, so no token or body travels with it. */
export class GitHubRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly headers: Readonly<Record<string, string>>,
  ) {
    super(message);
    this.name = "GitHubRequestError";
  }
}

/** Waits longer than this are not worth holding a read for: the caller falls back to what it last knew. */
const MAX_READ_WAIT_S = 60;

const ThrottledOctokit = Octokit.plugin(throttling, retry);

export function octokitClient(options: OctokitClientOptions = {}): GitHubClient {
  const now = options.now ?? Date.now;
  const state = budgetState(now);
  const octokit = new ThrottledOctokit({
    request: options.fetch ? { fetch: options.fetch } : {},
    throttle: {
      id: options.throttleId ?? "user",
      onRateLimit: (retryAfter, request, _octokit, retryCount) => state.limited("primary", request, retryAfter, retryCount),
      onSecondaryRateLimit: (retryAfter, request, _octokit, retryCount) => state.limited("secondary", request, retryAfter, retryCount),
    },
    // The throttle owns 403 and 429; 4xx answers are otherwise final.
    retry: { doNotRetry: [400, 401, 403, 404, 410, 422, 429, 451] },
  });
  octokit.hook.before("request", (request) => {
    // A write that may have landed is never sent twice.
    if (!isRead(request.method)) request.request = { ...request.request, retries: 0 };
  });
  authenticate(octokit, options.token ?? ghAuthToken, options.reauthOn401 ?? true, state.observe);
  return { request: octokit.request, budget: state.read };
}

let shared: GitHubClient | undefined;

/** One client per process, so every service call in it shares one throttle; the token is read on the first request. */
export function sharedOctokit(): GitHubClient {
  shared ??= octokitClient();
  return shared;
}

function isRead(method: string): boolean {
  return method === "GET" || method === "HEAD";
}

function laneOf(url: string): RateLane {
  return new URL(url, "https://api.github.com").pathname.startsWith("/graphql") ? "graphql" : "rest";
}

interface ThrottledRequest {
  method: string;
  url: string;
}

function budgetState(now: () => number) {
  const lanes: Partial<Record<RateLane, RateWindow>> = {};
  let cooldowns: Cooldown[] = [];
  return {
    limited(kind: Cooldown["class"], request: ThrottledRequest, retryAfterS: number, retryCount: number): boolean {
      const lane = laneOf(request.url);
      cooldowns = [...cooldowns.filter((cooldown) => cooldown.lane !== lane), { lane, class: kind, until: now() + retryAfterS * 1000 }];
      return retryCount === 0 && isRead(request.method) && retryAfterS <= MAX_READ_WAIT_S;
    },
    observe(headers: Readonly<Record<string, string | number | undefined>>): void {
      const lane = headers["x-ratelimit-resource"] === "core" ? "rest" : headers["x-ratelimit-resource"] === "graphql" ? "graphql" : undefined;
      const [limit, remaining, used, reset] = ["limit", "remaining", "used", "reset"].map((name) => Number(headers[`x-ratelimit-${name}`]));
      if (lane && [limit, remaining, used, reset].every(Number.isFinite)) lanes[lane] = { limit: limit!, remaining: remaining!, used: used!, resetAt: reset! * 1000 };
    },
    read: (): GatewayBudget => {
      cooldowns = cooldowns.filter((cooldown) => cooldown.until > now());
      return { lanes: structuredClone(lanes), cooldowns: cooldowns.map((cooldown) => ({ ...cooldown })) };
    },
  };
}

type Headers = Readonly<Record<string, string | number | undefined>>;

/** Outermost hook: the token rides in this request's header only, and a 401 re-reads it once. */
function authenticate(octokit: InstanceType<typeof ThrottledOctokit>, readToken: () => Promise<string>, reauth: boolean, observe: (headers: Headers) => void): void {
  let token: Promise<string> | undefined;
  const current = () => (token ??= readToken().catch((error: unknown) => ((token = undefined), Promise.reject(error))));
  octokit.hook.wrap("request", async (request, options) => {
    const send = async () => {
      const secret = await current();
      // Every hook in the chain is bound to this one options object, so a copy passed inward would be dropped.
      options.headers.authorization = `bearer ${secret}`;
      try {
        const response = await request(options);
        observe(response.headers as Headers);
        return response;
      } catch (error) {
        throw scrubbed(error, secret, observe);
      }
    };
    try {
      return await send();
    } catch (error) {
      if (!reauth || !(error instanceof GitHubRequestError) || error.status !== 401) throw error;
      token = undefined;
      return send();
    }
  });
}

function scrubbed(error: unknown, secret: string, observe: (headers: Headers) => void): Error {
  const failure = error as { status?: unknown; message?: unknown; response?: { headers?: Headers } };
  const message = redact(typeof failure.message === "string" ? failure.message : String(error), [secret]);
  if (typeof failure.status !== "number") return new Error(message);
  const headers = Object.fromEntries(Object.entries(failure.response?.headers ?? {}).flatMap(([key, value]) => (value === undefined ? [] : [[key, String(value)]])));
  observe(headers);
  return new GitHubRequestError(message, failure.status, headers);
}

/** The login `gh` already holds; its output is never echoed, since it is the token. */
async function ghAuthToken(): Promise<string> {
  const result = await execGh(["auth", "token"]);
  const token = result.stdout.trim();
  if (result.code !== 0 || token === "") throw new Error(`gh auth token failed (${result.code}): ${redact(result.stderr.trim(), [token])}`);
  return token;
}
