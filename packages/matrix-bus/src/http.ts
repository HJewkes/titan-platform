export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class MatrixError extends Error {
  constructor(
    readonly status: number,
    readonly errcode: string | undefined,
    readonly body: unknown,
    message: string,
  ) {
    super(message);
    this.name = "MatrixError";
  }
}

export interface RequestOptions {
  token?: string;
  body?: unknown;
  query?: Record<string, string | undefined>;
  signal?: AbortSignal;
}

export interface Transport {
  baseUrl: string;
  fetch?: FetchLike;
}

export function buildUrl(baseUrl: string, path: string, query: RequestOptions["query"] = {}): string {
  const url = new URL(path, baseUrl);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  return url.toString();
}

function parseBody(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function errcodeOf(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const code = (body as { errcode?: unknown }).errcode;
  return typeof code === "string" ? code : undefined;
}

export async function matrixRequest<T>(transport: Transport, method: string, path: string, options: RequestOptions = {}): Promise<T> {
  const doFetch = transport.fetch ?? globalThis.fetch;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  const res = await doFetch(buildUrl(transport.baseUrl, path, options.query), {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal,
  });
  const body = parseBody(await res.text());
  if (res.status >= 400) {
    const errcode = errcodeOf(body);
    throw new MatrixError(res.status, errcode, body, `${method} ${path} -> ${res.status} ${errcode ?? ""}`.trim());
  }
  return body as T;
}
