import { GhError } from "./exec.js";
import { GitHubRequestError, type GitHubClient } from "./octokit-client.js";
import { redact } from "./redact.js";
import { nextPage, type Fields, type Rest, type Revalidated } from "./rest.js";

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

interface Answer {
  status: number;
  headers: ReadonlyMap<string, string>;
  data: unknown;
}

interface Cached {
  etag: string;
  answer: Answer;
}

type Call = (method: Method, url: string, body?: string, etag?: string) => Promise<Answer>;

/**
 * The `Rest` port over one Octokit client, with `restCaller`'s semantics: GETs conditional on a bounded ETag cache, an
 * unconditional 304 refused, next pages followed only on the API origin. Retries and rate-limit waits are the client's.
 */
export function octokitRest(client: GitHubClient, cacheSize = 500): Rest {
  const call = caller(client);
  const conditional = conditionalGetter(call, cacheSize);
  const get = async <T>(path: string, fields: Fields = {}): Promise<T> => callerTyped((await conditional(withQuery(path, fields))).data);
  return {
    get,
    getOrNull: async <T>(path: string, fields?: Fields) => {
      try {
        return await get<T>(path, fields);
      } catch (error) {
        if (error instanceof GhError && error.status === 404) return null;
        throw error;
      }
    },
    pages: async <P, T>(path: string, fields: Fields, pick: (page: P) => T[]) => followPages(conditional, withQuery(path, fields), pick, []),
    revalidatePages: (path, fields, etag, pick) => revalidate(call, conditional, withQuery(path, fields), etag, pick),
    text: async (path: string) => {
      const { data } = await call("GET", path);
      return typeof data === "string" ? data : JSON.stringify(data);
    },
    send: async (method: Exclude<Method, "GET">, path: string, fields: Fields = {}, input?: string) => {
      if (input !== undefined) return callerTyped((await call(method, withQuery(path, fields), input)).data);
      return callerTyped((await call(method, path, Object.keys(fields).length === 0 ? undefined : JSON.stringify(fields))).data);
    },
  };
}

/** One ETag vouches for one page, so a list longer than a page answers with a null `etag`. */
async function revalidate<P, T>(call: Call, conditional: (url: string) => Promise<Answer>, url: string, etag: string | null, pick: (page: P) => T[]): Promise<Revalidated<T[]>> {
  const answer = await call("GET", url, undefined, etag ?? undefined);
  if (answer.status === 304) {
    if (etag === null) throw unconditional304(url);
    return { notModified: true };
  }
  const first = pick(callerTyped(answer.data));
  const next = nextPage(answer.headers.get("link"));
  if (!next) return { notModified: false, body: first, etag: answer.headers.get("etag") ?? null };
  return { notModified: false, body: await followPages(conditional, next, pick, first), etag: null };
}

/**
 * `Rest` lets its caller name the shape of GitHub's JSON, unchecked, the way `restCaller` types `JSON.parse`; this
 * overload is that one step, so no call site needs an assertion.
 */
function callerTyped<T>(data: unknown): T;
function callerTyped(data: unknown): unknown {
  return data;
}

/** Fields become the query here rather than Octokit parameters, so no field name can collide with an Octokit option. */
function withQuery(path: string, fields: Fields): string {
  const query = new URLSearchParams(fields).toString();
  if (!query) return path;
  return `${path}${path.includes("?") ? "&" : "?"}${query}`;
}

/** Octokit reads `:word` and `{word}` in a url as template variables and expands them to nothing, so `head=owner:branch` would lose its branch. */
function templateSafe(url: string): string {
  return url.replace(/[:{}]/g, (char) => encodeURIComponent(char));
}

/** A 304 answers, not throws, so the conditional readers can serve their cached body. */
function caller(client: GitHubClient): Call {
  return async (method, url, body, etag) => {
    try {
      const response = await client.request({
        method,
        url: `/${templateSafe(url)}`,
        headers: { ...(etag === undefined ? {} : { "if-none-match": etag }), ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { data: body }),
      });
      return { status: response.status, headers: headerMap(response.headers), data: response.data };
    } catch (error) {
      if (error instanceof GitHubRequestError && error.status === 304) return { status: 304, headers: headerMap(error.headers), data: undefined };
      throw asGhError(method, url, error);
    }
  };
}

/** Shaped like a failed `gh api` call, so `status`, `isTransient` and every caller's branch on them read the same. */
function asGhError(method: Method, url: string, error: unknown): GhError {
  const args = ["api", "-X", method, redact(url, [])];
  if (error instanceof GitHubRequestError) return new GhError(args, { code: 1, stdout: "", stderr: `${error.message} (HTTP ${error.status})` }, error.status);
  return new GhError(args, { code: 1, stdout: "", stderr: redact(error instanceof Error ? error.message : String(error), []) });
}

function headerMap(headers: Readonly<Record<string, unknown>>): ReadonlyMap<string, string> {
  return new Map(Object.entries(headers).flatMap(([key, value]) => (value === undefined ? [] : [[key.toLowerCase(), String(value)]])));
}

function unconditional304(url: string): Error {
  return new Error(`GET ${redact(url, [])} answered 304 to an unconditional request`);
}

function conditionalGetter(call: Call, cacheSize: number): (url: string) => Promise<Answer> {
  const cache = new Map<string, Cached>();
  return async (url) => {
    const hit = cache.get(url);
    const answer = await call("GET", url, undefined, hit?.etag);
    cache.delete(url);
    if (answer.status === 304) {
      if (!hit) throw unconditional304(url);
      cache.set(url, hit);
      return hit.answer;
    }
    const etag = answer.headers.get("etag");
    if (etag) cache.set(url, { etag, answer });
    if (cache.size > cacheSize) cache.delete(cache.keys().next().value!);
    return answer;
  };
}

async function followPages<P, T>(get: (url: string) => Promise<Answer>, start: string, pick: (page: P) => T[], items: T[]): Promise<T[]> {
  for (let url: string | null = start; url; ) {
    const answer = await get(url);
    items.push(...pick(callerTyped(answer.data)));
    url = nextPage(answer.headers.get("link"));
  }
  return items;
}
