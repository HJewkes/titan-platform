import type { RateBudget } from "./budget.js";
import { GhError, type GhExec, type GhResult } from "./exec.js";
import { redact, redactStreams } from "./redact.js";

export interface HttpResponse {
  status: number;
  /** Lower-cased names. */
  headers: ReadonlyMap<string, string>;
  body: string;
}

export type Fields = Record<string, string>;

/** A GET sent with the caller's own ETag: a 304 answers `notModified`, with no body and, on GitHub, no rate-limit point. */
type Revalidated<T> = { notModified: true } | { notModified: false; body: T; etag: string | null };

/** Every call is `gh api -i`, so the status line, ETag, Link and rate headers are all visible. */
export interface Rest {
  /** Conditional on the ETag of the same request's last 200; a 304 answers with that cached body. */
  get<T>(path: string, fields?: Fields): Promise<T>;
  getOrNull<T>(path: string, fields?: Fields): Promise<T | null>;
  /** Follows `Link: rel="next"`, each page conditional on its own ETag. */
  pages<P, T>(path: string, fields: Fields, pick: (page: P) => T[]): Promise<T[]>;
  /**
   * Like `pages`, but conditional on the caller's `etag` rather than the cache. One ETag vouches for one page, so a list
   * longer than a page answers every page with a null `etag`, and the caller's next read is unconditional.
   */
  revalidatePages<P, T>(path: string, fields: Fields, etag: string | null, pick: (page: P) => T[]): Promise<Revalidated<T[]>>;
  /** Unconditional, for bodies that are not JSON. */
  text(path: string): Promise<string>;
  send<T>(method: "POST" | "PUT" | "PATCH" | "DELETE", path: string, fields?: Fields, input?: string): Promise<T>;
}

const API_ORIGIN = "https://api.github.com/";

/** A response whose JSON body has already parsed, so the cache never holds a body that does not. */
interface Page {
  headers: ReadonlyMap<string, string>;
  data: unknown;
}

interface Cached {
  etag: string;
  page: Page;
}

/** Waits before attempts 2 and 3 of a read, so a persistent failure surfaces after about four seconds. */
const READ_RETRY_DELAYS_MS = [1000, 3000];

export function restCaller(exec: GhExec, budget: RateBudget, cacheSize: number, sleep: (ms: number) => Promise<void> = pause): Rest {
  const run = runner(exec, budget);
  const conditional = conditionalGetter(run, cacheSize);
  const retried = <A extends unknown[], R>(read: (...args: A) => Promise<R>) => (...args: A): Promise<R> => retryRead(() => read(...args), sleep);
  const get = retried(async <T>(path: string, fields: Fields = {}): Promise<T> => (await conditional(getArgs(path, fields))).data as T);
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
    pages: retried(async <P, T>(path: string, fields: Fields, pick: (page: P) => T[]) => followPages(conditional, getArgs(path, fields), pick, [])),
    revalidatePages: retried(async <P, T>(path: string, fields: Fields, etag: string | null, pick: (page: P) => T[]) => {
      const args = getArgs(path, fields);
      const response = await run(etag === null ? args : [...args, "-H", `If-None-Match: ${etag}`]);
      if (response.status === 304) {
        if (etag === null) throw new Error(`gh api ${args.join(" ")} answered 304 to an unconditional request`);
        return { notModified: true };
      }
      const first = pick(json<P>(response.body));
      const next = nextPage(response.headers.get("link"));
      if (!next) return { notModified: false, body: first, etag: response.headers.get("etag") ?? null };
      return { notModified: false, body: await followPages(conditional, getArgs(next, {}), pick, first), etag: null };
    }),
    text: retried(async (path: string) => (await run(getArgs(path, {}))).body),
    send: async <T>(method: string, path: string, fields: Fields = {}, input?: string) => {
      const args = ["-X", method, path, ...fieldArgs(fields), ...(input === undefined ? [] : ["--input", "-"])];
      return json<T>((await run(args, input)).body);
    },
  };
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Only reads go through here: a write that may have landed is never sent twice. 4xx answers are final. */
async function retryRead<R>(attempt: () => Promise<R>, sleep: (ms: number) => Promise<void>): Promise<R> {
  for (const delay of READ_RETRY_DELAYS_MS) {
    try {
      return await attempt();
    } catch (error) {
      if (!isTransient(error)) throw error;
      await sleep(delay);
    }
  }
  return attempt();
}

const CONNECTION_FAILURE = /error connecting|connection (reset|refused)|timed? ?out|ECONN|ETIMEDOUT|EOF|no such host|temporary failure|unexpected end of JSON input/i;

export function isTransient(error: unknown): boolean {
  if (error instanceof SyntaxError) return true;
  if (!(error instanceof GhError)) return false;
  if (error.status !== undefined) return error.status >= 500;
  return CONNECTION_FAILURE.test(error.result.stderr);
}

type Run = (args: readonly string[], input?: string) => Promise<HttpResponse>;

/** A 304 is not an error here even though `gh` exits 1 on it. */
function runner(exec: GhExec, budget: RateBudget): Run {
  return async (args, input) => {
    await budget.acquire();
    const full = ["api", "-i", ...args];
    const result = await exec(full, input);
    const response = parseIncluded(result.stdout);
    if (response) budget.observe(response.headers);
    if (response?.status === 304) return response;
    if (result.code !== 0 || (response && response.status >= 400)) throw new GhError(full, scrubbed(result), response?.status);
    return response ?? { status: 200, headers: new Map(), body: result.stdout };
  };
}

/** Every non-exchange call's error quotes raw `gh` output, which can carry a token shape. */
function scrubbed({ code, stdout, stderr }: GhResult): GhResult {
  const [cleanOut, cleanErr] = redactStreams(stdout, stderr, []);
  return { code, stdout: cleanOut, stderr: cleanErr };
}

async function followPages<P, T>(get: (args: readonly string[]) => Promise<Page>, start: string[], pick: (page: P) => T[], items: T[]): Promise<T[]> {
  for (let args: string[] | null = start; args; ) {
    const page = await get(args);
    items.push(...pick(page.data as P));
    const next = nextPage(page.headers.get("link"));
    args = next ? getArgs(next, {}) : null;
  }
  return items;
}

function conditionalGetter(run: Run, cacheSize: number): (args: readonly string[]) => Promise<Page> {
  const cache = new Map<string, Cached>();
  return async (args) => {
    const key = args.join("\0");
    const hit = cache.get(key);
    const response = await run(hit ? [...args, "-H", `If-None-Match: ${hit.etag}`] : args);
    cache.delete(key);
    if (response.status === 304) {
      if (!hit) throw new Error(`gh api ${args.join(" ")} answered 304 to an unconditional request`);
      cache.set(key, hit);
      return hit.page;
    }
    const page = { headers: response.headers, data: json<unknown>(response.body) };
    const etag = response.headers.get("etag");
    if (etag) cache.set(key, { etag, page });
    if (cache.size > cacheSize) cache.delete(cache.keys().next().value!);
    return page;
  };
}

export function parseIncluded(stdout: string): HttpResponse | null {
  const statusLine = /^HTTP\/[\d.]+ (\d{3})/.exec(stdout);
  if (!statusLine) return null;
  const blank = /\r?\n\r?\n/.exec(stdout);
  const head = blank ? stdout.slice(0, blank.index) : stdout;
  const body = blank ? stdout.slice(blank.index + blank[0].length) : "";
  const headers = new Map<string, string>();
  for (const line of head.split(/\r?\n/).slice(1)) {
    const colon = line.indexOf(":");
    if (colon > 0) headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }
  return { status: Number(statusLine[1]), headers, body };
}

/** Only an api.github.com link is followed, as a path, so a page URL can never point `gh` elsewhere. */
function nextPage(link: string | undefined): string | null {
  const next = link ? /<([^>]+)>;\s*rel="next"/.exec(link)?.[1] : undefined;
  if (!next) return null;
  if (!next.startsWith(API_ORIGIN)) throw new Error(`refusing to follow a next page outside ${API_ORIGIN}: ${redact(next, [])}`);
  return next.slice(API_ORIGIN.length);
}

function getArgs(path: string, fields: Fields): string[] {
  return ["-X", "GET", path, ...fieldArgs(fields)];
}

function fieldArgs(fields: Fields): string[] {
  return Object.entries(fields).flatMap(([key, value]) => ["-f", `${key}=${value}`]);
}

function json<T>(body: string): T {
  return (body.trim() ? JSON.parse(body) : undefined) as T;
}
