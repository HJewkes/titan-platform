import { CLIENT_HEADER } from "@titan-design/daemon";
import { z } from "zod";
import { EXIT } from "./exit-codes.js";
import type { ReviewGate } from "./gate-review-read.js";

/** Long enough for basement's gates-review GitHub reads, short enough that a dead forward fails before the proof window does. */
export const REMOTE_TIMEOUT_MS = 20_000;

/** Any failure talking to the remote factory; `exit` is the CLI status a caller reports it with. */
export class RemoteFactoryError extends Error {
  constructor(message: string, readonly exit: number) {
    super(message);
  }
}

/** The remote did not answer: connection refused, the forward is down, or it timed out. */
export class UnavailableError extends RemoteFactoryError {
  constructor(message: string) {
    super(message, EXIT.UNAVAILABLE);
  }
}

/** The remote answered, but not with what this client can read. */
export class RemoteFailedError extends RemoteFactoryError {
  constructor(message: string) {
    super(message, EXIT.FAILURE);
  }
}

export interface ProofBody {
  statement: string;
  signature: string;
}

export interface RemoteFactory {
  readonly base: string;
  gatesReview(): Promise<{ aud: string; gates: ReviewGate[] }>;
  /** Key ids the remote's owner key ring holds; empty when it reports no ring installed. */
  ownerKeyIds(): Promise<string[]>;
  /** The route's own status and JSON body, refusals included; only a missing or unreadable answer throws. */
  postProof(path: string, body: ProofBody): Promise<{ status: number; body: Record<string, unknown> }>;
}

type Fetch = typeof fetch;

const ReviewGateShape: z.ZodType<ReviewGate> = z.object({
  gateId: z.string().min(1),
  runId: z.string().min(1),
  stepId: z.string().min(1),
  repo: z.string().nullable(),
  pr: z.number().int().positive().nullable(),
  headSha: z.string().nullable(),
  rule: z.string().nullable(),
  batchable: z.union([z.literal(true), z.strictObject({ refusal: z.string() })]),
  verdict: z.object({ verdict: z.string(), reviewer: z.string() }).nullable(),
  checks: z.object({ state: z.enum(["green", "failing", "pending", "unreadable"]), failing: z.array(z.string()) }),
  createdAt: z.string(),
});
const GatesReviewEnvelope = z.union([
  z.object({ ok: z.literal(true), data: z.object({ aud: z.string().min(1), gates: z.array(ReviewGateShape) }) }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);
const Health = z.object({
  ownerKeys: z.union([z.object({ ids: z.array(z.string()) }), z.object({ refusal: z.string() })]),
});
const JsonObject = z.record(z.string(), z.unknown());

/** A client for the factory at `base` (the config's `remoteFactory`); every request carries the daemon's client header. */
export function remoteFactory(base: string, fetchImpl: Fetch = fetch, timeoutMs = REMOTE_TIMEOUT_MS): RemoteFactory {
  const root = baseUrl(base);
  const request = (path: string, init: RequestInit) => send(fetchImpl, `${root}${path}`, init, timeoutMs);
  return {
    base: root,
    gatesReview: async () => {
      const answer = await request("/rpc/factory.gates-review", post({}));
      const envelope = parsed(GatesReviewEnvelope, answer, "factory.gates-review");
      if (!envelope.ok) throw new RemoteFailedError(`factory.gates-review at ${root} failed: ${envelope.error}`);
      return envelope.data;
    },
    ownerKeyIds: async () => {
      const answer = await request("/health", { method: "GET", headers: { [CLIENT_HEADER]: "titan-factory" } });
      const { ownerKeys } = parsed(Health, answer, "/health");
      return "ids" in ownerKeys ? ownerKeys.ids : [];
    },
    postProof: async (path, body) => {
      const answer = await request(path, post(body));
      const why = "the proof may still have been applied; read factory.gates-review before signing again";
      return { status: answer.status, body: parsed(JsonObject, answer, path, why) };
    },
  };
}

function baseUrl(base: string): string {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new RemoteFailedError(`remoteFactory ${JSON.stringify(base)} is not a URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new RemoteFailedError(`remoteFactory ${base} is not an http(s) URL`);
  return url.href.replace(/\/+$/, "");
}

function post(body: unknown): RequestInit {
  return { method: "POST", headers: { "content-type": "application/json", [CLIENT_HEADER]: "titan-factory" }, body: JSON.stringify(body) };
}

interface Answer {
  url: string;
  status: number;
  text: string;
}

async function send(fetchImpl: Fetch, url: string, init: RequestInit, timeoutMs: number): Promise<Answer> {
  try {
    const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    return { url, status: res.status, text: await res.text() };
  } catch (error) {
    const how = isTimeout(error) ? `did not answer within ${timeoutMs / 1000} s` : `is unreachable (${reason(error)})`;
    throw new UnavailableError(`the remote factory at ${url} ${how}; check the ssh LocalForward to the live factory's port`);
  }
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

function reason(error: unknown): string {
  const cause = error instanceof Error ? (error.cause as { code?: unknown } | undefined) : undefined;
  if (typeof cause?.code === "string") return cause.code;
  return error instanceof Error ? error.message : String(error);
}

function parsed<T>(schema: z.ZodType<T>, answer: Answer, what: string, why?: string): T {
  let json: unknown;
  try {
    json = JSON.parse(answer.text);
  } catch {
    throw new RemoteFailedError(`${what} at ${answer.url} answered HTTP ${answer.status} with a body that is not JSON${why ? `; ${why}` : ""}`);
  }
  const result = schema.safeParse(json);
  if (!result.success) throw new RemoteFailedError(`${what} at ${answer.url} answered HTTP ${answer.status} in an unexpected shape${why ? `; ${why}` : ""}`);
  return result.data;
}
