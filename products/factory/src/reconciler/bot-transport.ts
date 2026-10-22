import { GitHubRequestError, RATE_LIMIT_PHRASES, octokitRest, octokitWire, readBackstopSnapshot, type GitHubClient, type GitHubWire, type PoolAnswer } from "@titan-design/github";
import type { BackstopAnswer, BackstopCall } from "./service.js";

/** The branch the service's snapshot reads; the ref gate revalidates the same one. */
const BRANCH = "main";

/** The gate etags, keyed by read; a missing key sends that read unconditionally. */
export const GATE_KEYS = { pulls: "pulls", ref: "ref", rulesets: "rulesets" } as const;

type Etags = Record<string, string | null>;

/** The HTTP answer behind the read that failed, kept so the pool classifies GitHub's own status and headers. */
interface Seen {
  status?: number;
  headers: Record<string, string>;
  networkError: boolean;
}

/**
 * The bot's `send`: each call is one fresh read over `client`, so no ETag cache outlives it. A GitHub failure answers its
 * status and headers for the pool to classify; a read that fails for any other reason throws, and its unit fails.
 */
export function botTransport(client: GitHubClient): (call: BackstopCall) => Promise<BackstopAnswer> {
  return async (call) => {
    const seen: Seen = { headers: {}, networkError: false };
    const traced = tracing(client, seen);
    try {
      if (call.kind === "gates") return { status: 200, headers: seen.headers, gates: await readGates(octokitWire({ client: traced, etagCacheSize: 0 }), call.repo, call.etags) };
      return { status: 200, headers: seen.headers, snapshot: await readBackstopSnapshot(octokitRest(traced, 0), call.request) };
    } catch (error) {
      return failureAnswer(error, seen);
    }
  };
}

/** All three reads go out every time: a 304 costs no rate-limit point, and one read skipped is one change missed. */
async function readGates(wire: GitHubWire, repo: string, etags: Etags): Promise<{ changed: boolean; etags: Etags }> {
  const pulls = await wire.revalidateOpenPrs(repo, etags[GATE_KEYS.pulls] ?? null);
  const ref = await wire.revalidateRef(repo, BRANCH, etags[GATE_KEYS.ref] ?? null);
  const rulesets = await wire.revalidateRulesets(repo, etags[GATE_KEYS.rulesets] ?? null);
  const next = (key: string, read: { notModified: true } | { notModified: false; etag?: string | null }) => (read.notModified ? (etags[key] ?? null) : (read.etag ?? null));
  return {
    // A free-plan repo's rulesets are unknown on every read, so they cannot say whether anything changed.
    changed: !pulls.notModified || !ref.notModified || (!rulesets.notModified && !rulesets.unreadable),
    etags: { [GATE_KEYS.pulls]: next(GATE_KEYS.pulls, pulls), [GATE_KEYS.ref]: next(GATE_KEYS.ref, ref), [GATE_KEYS.rulesets]: next(GATE_KEYS.rulesets, rulesets) },
  };
}

function failureAnswer(error: unknown, seen: Seen): PoolAnswer {
  const message = error instanceof Error ? error.message : String(error);
  if (seen.networkError) return { headers: {}, message, networkError: true };
  if (seen.status !== undefined && seen.status >= 400) return { status: seen.status, headers: seen.headers, message };
  // GraphQL answers its primary limit as a 200 whose errors name it; as a 403 the pool classifies it as the limit it is.
  if (RATE_LIMIT_PHRASES.some((phrase) => phrase.test(message))) return { status: 403, headers: seen.headers, message };
  throw error;
}

/** `client` with each answer's status and headers, or its network failure, written to `seen`. */
function tracing(client: GitHubClient, seen: Seen): GitHubClient {
  const request = async (...args: Parameters<GitHubClient["request"]>) => {
    try {
      const response = await client.request(...args);
      Object.assign(seen, { status: response.status, headers: lowerCased(response.headers), networkError: false });
      return response;
    } catch (error) {
      const answered = error instanceof GitHubRequestError;
      Object.assign(seen, answered ? { status: error.status, headers: lowerCased(error.headers), networkError: false } : { status: undefined, headers: {}, networkError: true });
      throw error;
    }
  };
  return { request: Object.assign(request, client.request), budget: () => client.budget() };
}

function lowerCased(headers: Readonly<Record<string, unknown>>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).flatMap(([key, value]) => (value === undefined ? [] : [[key.toLowerCase(), String(value)]])));
}
