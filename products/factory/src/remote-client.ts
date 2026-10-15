import { CLIENT_HEADER } from "@titan-design/daemon";
import { z } from "zod";
import { EXIT } from "./exit-codes.js";
import type { ReviewGate } from "./gate-review-read.js";
import { HOLD_RELEASE_PROOF_PATH, RESOLVE_PROOF_PATH } from "./resolve-proof.js";

/** Long enough for basement's gates-review GitHub reads, short enough that a dead forward fails before the proof window does. */
const REMOTE_TIMEOUT_MS = 20_000;
/** Far above any real pending queue; a longer list is a misbehaving remote, not gates to show the owner. */
export const MAX_REVIEW_GATES = 1000;
const MAX_PROOF_ITEMS = 200;

/** Any failure talking to the remote factory; `exit` is the CLI status a caller reports it with. */
class RemoteFactoryError extends Error {
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

interface ProofBody {
  statement: string;
  signature: string;
}

type ProofPath = typeof RESOLVE_PROOF_PATH | typeof HOLD_RELEASE_PROOF_PATH;

// Everything here reaches the owner's terminal or Touch ID dialog, so an escape sequence or bidi override must not.
const UNPRINTABLE = /[\p{Cc}\p{Cf}]/u;
const printable = (min = 0) => z.string().min(min).refine((text) => !UNPRINTABLE.test(text), "control characters");

const ProofOutcome = z.object({
  gate: printable(1),
  outcome: z.enum(["signed", "firing", "resolved", "skipped-moved", "skipped-closed", "skipped-unreadable", "failed"]),
  detail: printable().optional(),
});
const ProofApplied = {
  [RESOLVE_PROOF_PATH]: z.object({ ok: z.literal(true), batchId: printable(1), items: z.array(ProofOutcome).min(1).max(MAX_PROOF_ITEMS) }),
  [HOLD_RELEASE_PROOF_PATH]: z.looseObject({ ok: z.literal(true), batchId: printable(1) }),
};
const ProofRefused = z.object({ ok: z.literal(false), error: printable(1), refusal: printable().optional(), detail: printable().optional() });

type ProofAnswer =
  | { status: number; body: z.infer<(typeof ProofApplied)[ProofPath]> }
  | { status: number; body: z.infer<typeof ProofRefused> };

interface RemoteFactory {
  readonly base: string;
  gatesReview(): Promise<{ aud: string; gates: ReviewGate[] }>;
  /** Key ids the remote's owner key ring holds; empty when it reports no ring installed. */
  ownerKeyIds(): Promise<string[]>;
  /** The route's own answer, refusals included; a missing, unreadable or outcome-less answer throws. */
  postProof(path: ProofPath, body: ProofBody): Promise<ProofAnswer>;
}

type Fetch = typeof fetch;

const ReviewGateShape: z.ZodType<ReviewGate> = z.object({
  gateId: printable(1),
  runId: printable(1),
  stepId: printable(1),
  repo: printable(1).nullable(),
  pr: z.number().int().positive().nullable(),
  headSha: printable(1).nullable(),
  rule: printable().nullable(),
  batchable: z.union([z.literal(true), z.strictObject({ refusal: printable() })]),
  verdict: z.object({ verdict: printable(), reviewer: printable() }).nullable(),
  checks: z.object({ state: z.enum(["green", "failing", "pending", "unreadable"]), failing: z.array(printable()) }),
  createdAt: printable(),
});
const ReviewGates = z.array(ReviewGateShape).max(MAX_REVIEW_GATES).refine(
  (gates) => new Set(gates.map(({ gateId }) => gateId)).size === gates.length,
  "duplicate gate ids",
);
const GatesReviewEnvelope = z.union([
  z.object({ ok: z.literal(true), data: z.object({ aud: printable(1), gates: ReviewGates }) }),
  z.object({ ok: z.literal(false), error: printable() }),
]);
const KEY_ID = z.string().regex(/^[0-9a-f]{16}$/);
const Health = z.object({
  ownerKeys: z.union([z.object({ ids: z.array(KEY_ID) }), z.object({ refusal: z.string() })]),
});

const AFTER_POST = "the proof may have applied; read factory.gates-review before signing again";

/** A client for the factory at `base` (the config's `remoteFactory`); every request carries the daemon's client header. */
export function remoteFactory(base: string, fetchImpl: Fetch = fetch, timeoutMs = REMOTE_TIMEOUT_MS): RemoteFactory {
  const root = origin(base);
  const request = (path: string, init: RequestInit, afterSend?: string) => send(fetchImpl, target(root, path), { ...init, timeoutMs, afterSend });
  return {
    base: root,
    gatesReview: async () => {
      const answer = await request("/rpc/factory.gates-review", post({}));
      const envelope = parsed(GatesReviewEnvelope, answer, "factory.gates-review");
      if (!envelope.ok) throw new RemoteFailedError(`factory.gates-review at ${root} failed (HTTP ${answer.status}): ${envelope.error}`);
      requireSuccess(answer, "factory.gates-review");
      return envelope.data;
    },
    ownerKeyIds: async () => {
      const answer = await request("/health", { method: "GET", headers: { [CLIENT_HEADER]: "titan-factory" } });
      requireSuccess(answer, "/health");
      const { ownerKeys } = parsed(Health, answer, "/health");
      return "ids" in ownerKeys ? ownerKeys.ids : [];
    },
    postProof: async (path, body) => {
      const answer = await request(proofPath(path), post(body), AFTER_POST);
      if (!isSuccess(answer)) return { status: answer.status, body: parsed(ProofRefused, answer, path, AFTER_POST) };
      return { status: answer.status, body: parsed(ProofApplied[path], answer, path, AFTER_POST) };
    },
  };
}

function origin(base: string): string {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new RemoteFailedError(`remoteFactory ${JSON.stringify(base)} is not a URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new RemoteFailedError(`remoteFactory ${base} is not an http(s) URL`);
  const extra = beyondOrigin(url, base);
  if (extra) throw new RemoteFailedError(`remoteFactory ${url.origin} must be a bare origin; it carries ${extra}`);
  return url.origin;
}

function beyondOrigin(url: URL, base: string): string | undefined {
  if (url.username || url.password) return "credentials";
  if (url.search || base.includes("?")) return "a query";
  if (url.hash || base.includes("#")) return "a fragment";
  return url.pathname === "/" ? undefined : "a path";
}

const PATH = /^(\/[A-Za-z0-9_~-][A-Za-z0-9._~-]*)+$/;

/** Joins only plain absolute paths with no dot segments, so no path can move the request to another host, query or parent. */
function target(root: string, path: string): string {
  const url = PATH.test(path) ? new URL(`${root}${path}`) : undefined;
  if (url?.origin !== root) throw new RemoteFailedError(`refused to request ${JSON.stringify(path)}: not a plain absolute path`);
  return url.href;
}

function proofPath(path: string): ProofPath {
  if (path === RESOLVE_PROOF_PATH || path === HOLD_RELEASE_PROOF_PATH) return path;
  throw new RemoteFailedError(`refused to post a proof to ${JSON.stringify(path)}: not a proof route`);
}

function post(body: unknown): RequestInit {
  return { method: "POST", headers: { "content-type": "application/json", [CLIENT_HEADER]: "titan-factory" }, body: JSON.stringify(body) };
}

interface Answer {
  url: string;
  status: number;
  text: string;
}

async function send(fetchImpl: Fetch, url: string, init: RequestInit & { timeoutMs: number; afterSend?: string }): Promise<Answer> {
  const { timeoutMs, afterSend, ...rest } = init;
  try {
    // A redirect would re-send a signed proof to wherever Location points.
    const res = await fetchImpl(url, { ...rest, redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
    return { url, status: res.status, text: await res.text() };
  } catch (error) {
    throw unanswered(url, error, timeoutMs, afterSend);
  }
}

function unanswered(url: string, error: unknown, timeoutMs: number, afterSend?: string): RemoteFactoryError {
  const cause = error instanceof Error ? error.cause : undefined;
  if (cause instanceof Error && cause.message === "unexpected redirect") return new RemoteFailedError(`the remote factory at ${url} answered with a redirect, which is never followed`);
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return new UnavailableError(`the remote factory at ${url} did not answer within ${timeoutMs / 1000} s${afterSend ? `; ${afterSend}` : ""}`);
  }
  return new UnavailableError(`the remote factory at ${url} is unreachable (${reason(error)}); check the ssh LocalForward to the live factory's port`);
}

function reason(error: unknown): string {
  const cause = error instanceof Error ? error.cause : undefined;
  if (typeof cause === "object" && cause !== null && "code" in cause && typeof cause.code === "string") return cause.code;
  return error instanceof Error ? error.message : String(error);
}

function isSuccess(answer: Answer): boolean {
  return answer.status >= 200 && answer.status < 300;
}

function requireSuccess(answer: Answer, what: string): void {
  if (!isSuccess(answer)) throw new RemoteFailedError(`${what} at ${answer.url} answered HTTP ${answer.status}`);
}

function parsed<T>(schema: z.ZodType<T>, answer: Answer, what: string, why?: string): T {
  const tail = why ? `; ${why}` : "";
  let json: unknown;
  try {
    json = JSON.parse(answer.text);
  } catch {
    throw new RemoteFailedError(`${what} at ${answer.url} answered HTTP ${answer.status} with a body that is not JSON${tail}`);
  }
  const result = schema.safeParse(json);
  if (!result.success) throw new RemoteFailedError(`${what} at ${answer.url} answered HTTP ${answer.status} in an unexpected shape (${result.error.issues[0]?.message ?? "invalid"})${tail}`);
  return result.data;
}
