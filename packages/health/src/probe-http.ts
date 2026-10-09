import { parseHealthReport } from "./contract.js";
import type { HealthSample } from "./sample.js";

export interface ProbeHttpTarget {
  name: string;
  url: string;
  timeoutMs: number;
  /** The port the payload must report; a stranger bound to the port must not read as up. */
  expectPort?: number;
  /** Dot paths into the payload (such as `build.sha`) copied into `observed`; a missing path is left out. */
  observe?: string[];
}

export interface ProbeHttpDeps {
  fetch?: (url: string, init?: { signal?: AbortSignal; redirect?: RequestRedirect }) => Promise<Response>;
  /** Epoch milliseconds. */
  now?: () => number;
  /** Runs `fire` once `ms` have passed and returns a cancel. */
  after?: (ms: number, fire: () => void) => () => void;
  /** The pid the target must report, or null when its pid file is missing; identity is skipped when unset. */
  expectedPid?: () => Promise<number | null>;
}

type Exchange =
  | { kind: "answer"; code: number; body: string }
  | { kind: "timeout" }
  | { kind: "unreachable"; reason: string };

type Verdict = Pick<HealthSample, "status" | "output" | "observed">;

function realAfter(ms: number, fire: () => void): () => void {
  const timer = setTimeout(fire, ms);
  return () => clearTimeout(timer);
}

/**
 * GETs a health route once and returns one sample. A target that is down, slow or answering as
 * someone else is a `fail` sample, not an error; a probe that cannot decide is `unknown`.
 */
export async function probeHttp(target: ProbeHttpTarget, deps: ProbeHttpDeps = {}): Promise<HealthSample> {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  let answeredAt: number | undefined;
  let verdict: Verdict;
  try {
    verdict = await probeOnce(target, deps, () => (answeredAt = now()));
  } catch (error) {
    verdict = { status: "unknown", output: `probe error: ${errorMessage(error)}` };
  }
  return {
    ts: new Date(startedAt).toISOString(),
    target: target.name,
    kind: "http",
    latencyMs: Math.max(0, (answeredAt ?? now()) - startedAt),
    source: "probe",
    ...verdict,
  };
}

// Latency stops when the exchange ends, so a slow pid file read is not charged to the target.
async function probeOnce(target: ProbeHttpTarget, deps: ProbeHttpDeps, markAnswered: () => void): Promise<Verdict> {
  const url = parseTargetUrl(target.url);
  if (typeof url !== "string") return url;
  const exchange = await exchangeWithin(url, target.timeoutMs, deps);
  markAnswered();
  if (exchange.kind === "timeout") return { status: "fail", output: `timeout after ${target.timeoutMs} ms` };
  if (exchange.kind === "unreachable") return { status: "fail", output: `unreachable: ${exchange.reason}` };
  return await judgeAnswer(target, exchange, deps);
}

// Samples are stored forever and fetch echoes a credentialed URL in its error, so such a URL is
// refused up front with fixed text; fetch would refuse it anyway. Parse errors get fixed text too.
function parseTargetUrl(raw: string): string | Verdict {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { status: "unknown", output: "probe error: the URL does not parse" };
  }
  if (url.username || url.password) {
    return { status: "unknown", output: "probe error: the URL carries credentials, refused before any request" };
  }
  return url.href;
}

/** The timeout covers the body too, so a server that sends headers and then stalls still times out. */
async function exchangeWithin(url: string, timeoutMs: number, deps: ProbeHttpDeps): Promise<Exchange> {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const controller = new AbortController();
  let cancel = (): void => {};
  const expiry = new Promise<Exchange>((resolve) => {
    cancel = (deps.after ?? realAfter)(timeoutMs, () => {
      controller.abort();
      resolve({ kind: "timeout" });
    });
  });
  const request = (async (): Promise<Exchange> => {
    // A redirect is judged as itself; following it would score whatever the health route points at.
    const response = await doFetch(url, { signal: controller.signal, redirect: "manual" });
    return { kind: "answer", code: response.status, body: await response.text() };
  })().catch((error: unknown): Exchange => ({ kind: "unreachable", reason: transportReason(error) }));
  try {
    return await Promise.race([request, expiry]);
  } finally {
    cancel();
  }
}

async function judgeAnswer(
  target: ProbeHttpTarget,
  answer: { code: number; body: string },
  deps: ProbeHttpDeps,
): Promise<Verdict> {
  const observed: Record<string, unknown> = { code: answer.code };
  if (answer.code < 200 || answer.code > 299) return { status: "fail", observed, output: `HTTP ${answer.code}` };
  const payload = parseJson(answer.body);
  if (payload === undefined) return { status: "fail", observed, output: "body is not JSON" };
  Object.assign(observed, observePaths(payload, target.observe ?? []));
  const read = parseHealthReport(payload);
  if (!read.ok) return { status: "fail", observed, output: `payload: ${read.error}` };
  const mismatch = await identityMismatch(target, read.report, deps);
  if (mismatch) return { status: "fail", observed, output: `identity: ${mismatch}` };
  return { status: read.report.status, observed };
}

async function identityMismatch(
  target: ProbeHttpTarget,
  report: { pid?: number; port?: number },
  deps: ProbeHttpDeps,
): Promise<string | undefined> {
  if (target.expectPort !== undefined && report.port !== target.expectPort) {
    return `port ${report.port ?? "missing"} answered, expected ${target.expectPort}`;
  }
  if (!deps.expectedPid) return undefined;
  const expected = await deps.expectedPid();
  if (expected === null) return "pid file is missing while the port answers";
  if (report.pid !== expected) return `pid ${report.pid ?? "missing"} answered, expected ${expected}`;
  return undefined;
}

function observePaths(payload: unknown, paths: string[]): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const path of paths) {
    const value = path.split(".").reduce<unknown>((node, key) => (isRecord(node) ? node[key] : undefined), payload);
    if (value !== undefined) picked[path] = value;
  }
  return picked;
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
}

// undici wraps the socket error (ECONNREFUSED, ENOTFOUND) as the cause of a generic "fetch failed".
function transportReason(error: unknown): string {
  const cause = error instanceof Error ? error.cause : undefined;
  if (isRecord(cause) && typeof cause.code === "string") return cause.code;
  return errorMessage(error);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
