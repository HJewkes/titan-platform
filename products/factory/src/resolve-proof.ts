import type { Logger, StartDaemonOptions } from "@titan-design/daemon";
import type { GitHubPort } from "@titan-design/github";
import { EXIT, errorEnvelope } from "@titan-design/registry";
import { z } from "zod";
import { applyProof } from "./gate-batch.js";
import { applyHoldRelease } from "./hold-release-proof.js";
import type { FactoryHost } from "./host.js";
import type { OwnerKeys } from "./owner-keys.js";
import type { KeyRing, ProofInput } from "./presence-proof.js";
import type { ShepherdStoreRef } from "./shepherd/store.js";

export const RESOLVE_PROOF_PATH = "/gates/resolve-proof";
export const HOLD_RELEASE_PROOF_PATH = "/holds/release-proof";
/** Room for the largest statement `verifyProof` accepts (256 KiB, base64url) plus its signature. */
export const MAX_PROOF_BODY_BYTES = 512 * 1024;

type App = Parameters<NonNullable<StartDaemonOptions["mountRoutes"]>>[0];
type Status = 400 | 403 | 409 | 413 | 500 | 503;
type Answer = { body: object; status: 200 | Status };

export const TOO_LARGE = Symbol("too-large");
const ProofBody = z.strictObject({ statement: z.string().min(1), signature: z.string().min(1) });

interface ResolveProofDeps {
  host: FactoryHost;
  keys: OwnerKeys;
  /** This factory's hostname; `factory.gates` reports the same value for the signer to bind. */
  aud: string;
  now: () => number;
  /** Fresh PR reads for merge gates and hold releases; absent without the shepherd routes. */
  port?: Pick<GitHubPort, "getPr">;
  /** The Shepherd registrations a hold release lifts; absent without the shepherd routes, and then that route answers 503. */
  store?: ShepherdStoreRef;
  log: Logger;
}

type Apply = (proof: ProofInput, ring: KeyRing, deps: ResolveProofDeps) => Promise<Answer>;

const STATUS_OF: Record<string, Status> = {
  malformed: 400,
  "replayed-nonce": 409,
  "item-refused": 409,
  "run-mismatch": 409,
  "not-held": 409,
  "hold-changed": 409,
  "head-moved": 409,
  "head-unreadable": 503,
};

/**
 * Mounted on serve through the daemon's `mountRoutes`, behind its Host, Origin, client-header and JSON guards, and kept
 * out of the registry so neither route is ever an MCP tool or RPC command. The signature is the authority, not the caller,
 * so an agent that posts here gets nothing without the owner's enclave key. Logs carry refusals and outcomes, never the proof.
 */
export function mountResolveProof(app: App, deps: ResolveProofDeps): void {
  mountProofRoute(app, RESOLVE_PROOF_PATH, deps, resolveGates);
  mountProofRoute(app, HOLD_RELEASE_PROOF_PATH, deps, releaseHold);
}

function mountProofRoute(app: App, path: string, deps: ResolveProofDeps, apply: Apply): void {
  app.post(path, async (c) => {
    const answer = await answerProof(c.req.raw, deps, apply);
    // An unread oversize body would otherwise hold the keep-alive socket until the server gives up draining it.
    if (answer.status === 413) c.header("connection", "close");
    return c.json(answer.body, answer.status);
  });
}

async function answerProof(request: Request, deps: ResolveProofDeps, apply: Apply): Promise<Answer> {
  if (!deps.keys.ok) return refuse(503, "owner keys not installed", { detail: deps.keys.refusal });
  const raw = await readCapped(request, MAX_PROOF_BODY_BYTES);
  if (raw === TOO_LARGE) return refuse(413, `proof body over ${MAX_PROOF_BODY_BYTES} bytes`);
  const body = parseBody(raw);
  if (body === undefined) return refuse(400, "body must be {statement, signature}, both base64url strings");
  try {
    return await apply({ statementB64: body.statement, signatureB64: body.signature }, deps.keys.ring, deps);
  } catch (error) {
    deps.log.error({ err: error instanceof Error ? error.message : String(error) }, "applying an owner proof failed");
    return refuse(500, "applying the proof failed");
  }
}

async function resolveGates(proof: ProofInput, ring: KeyRing, deps: ResolveProofDeps): Promise<Answer> {
  const result = await applyProof(deps.host, proof, ring, { now: deps.now, aud: deps.aud, port: deps.port });
  if (!result.ok) return refused(deps.log, result);
  deps.log.info({ batchId: result.batchId, items: result.items.map(({ gate, outcome }) => ({ gate, outcome })) }, "applied an owner proof");
  return { body: { ok: true, batchId: result.batchId, items: result.items }, status: 200 };
}

async function releaseHold(proof: ProofInput, ring: KeyRing, deps: ResolveProofDeps): Promise<Answer> {
  if (deps.store === undefined || deps.port === undefined) return refuse(503, "shepherd routes not mounted");
  const result = await applyHoldRelease(deps.host, deps.store.get(), proof, ring, { now: deps.now, aud: deps.aud, port: deps.port });
  if (!result.ok) return refused(deps.log, result);
  deps.log.info({ batchId: result.batchId, runId: result.runId, actor: result.actor }, "released a hold on an owner proof");
  return { body: result, status: 200 };
}

function refused(log: Logger, result: { refusal: string; detail?: string; batchId?: string }): Answer {
  log.warn({ refusal: result.refusal, detail: result.detail }, "refused an owner proof");
  return refuse(STATUS_OF[result.refusal] ?? 403, `owner proof refused: ${result.refusal}`, { refusal: result.refusal, detail: result.detail, ...(result.batchId !== undefined && { batchId: result.batchId }) });
}

function refuse(status: Status, message: string, extra: Record<string, unknown> = {}): Answer {
  const code = status === 503 ? EXIT.UNAVAILABLE : status === 500 ? EXIT.SOFTWARE : EXIT.DATAERR;
  return { body: { ...errorEnvelope(message, code), ...extra }, status };
}

function parseBody(raw: string): z.infer<typeof ProofBody> | undefined {
  try {
    const parsed = ProofBody.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Stops reading at `max` bytes, so an oversize body costs no more memory than the limit, whatever Content-Length claims. */
export async function readCapped(request: Request, max: number): Promise<string | typeof TOO_LARGE> {
  if (Number(request.headers.get("content-length") ?? 0) > max) return TOO_LARGE;
  const reader = request.body?.getReader();
  if (reader === undefined) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (let read = await reader.read(); !read.done; read = await reader.read()) {
    size += read.value.byteLength;
    if (size > max) {
      await reader.cancel();
      return TOO_LARGE;
    }
    chunks.push(read.value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
