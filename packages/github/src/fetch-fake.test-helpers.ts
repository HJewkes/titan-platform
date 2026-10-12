/** One recorded request to the fake GitHub API. */
export interface FetchCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | undefined;
}

export interface FakeAnswer {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export const API = "https://api.github.com/";

/** A `fetch` that answers from `answer`, recording each call; tests hand it to `octokitClient`. */
export function fakeFetch(answer: (call: FetchCall, index: number) => FakeAnswer): { fetch: typeof globalThis.fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([key, value]) => [key.toLowerCase(), String(value)]));
    const call = { method: init.method ?? "GET", url: String(input), headers, body: typeof init.body === "string" ? init.body : undefined };
    calls.push(call);
    const { status, body, headers: answerHeaders = {} } = answer(call, calls.length - 1);
    const text = body === undefined || status === 204 || status === 304 ? null : typeof body === "string" ? body : JSON.stringify(body);
    return new Response(text, { status, headers: { "content-type": typeof body === "string" ? "text/plain" : "application/json; charset=utf-8", ...answerHeaders } });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

export const secondaryLimit = (retryAfter: string): FakeAnswer => ({
  status: 403,
  body: { message: "You have exceeded a secondary rate limit. Please wait a few minutes before you try again." },
  headers: { "retry-after": retryAfter },
});
