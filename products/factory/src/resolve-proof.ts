import type { Logger, StartDaemonOptions } from "@titan-design/daemon";
import type { GitHubPort } from "@titan-design/github";
import { EXIT, errorEnvelope } from "@titan-design/registry";
import { z } from "zod";
import { applyProof } from "./gate-batch.js";
import type { FactoryHost } from "./host.js";
import type { OwnerKeys } from "./owner-keys.js";

export const RESOLVE_PROOF_PATH = "/gates/resolve-proof";
/** Room for the largest statement `verifyProof` accepts (256 KiB, base64url) plus its signature. */
export const MAX_PROOF_BODY_BYTES = 512 * 1024;

type App = Parameters<NonNullable<StartDaemonOptions["mountRoutes"]>>[0];
type Status = 400 | 403 | 409 | 413 | 500 | 503;

const TOO_LARGE = Symbol("too-large");
const ProofBody = z.strictObject({ statement: z.string().min(1), signature: z.string().min(1) });

export interface ResolveProofDeps {
  host: FactoryHost;
  keys: OwnerKeys;
  /** This factory's hostname; `factory.gates` reports the same value for the signer to bind. */
  aud: string;
  now: () => number;
  /** Fresh PR reads for merge gates; absent without the shepherd routes. */
  port?: Pick<GitHubPort, "getPr">;
  log: Logger;
}

const STATUS_OF: Record<string, Status> = { malformed: 400, "replayed-nonce": 409, "item-refused": 409 };

/**
 * Mounted on serve through the daemon's `mountRoutes`, behind its Host, Origin, client-header and JSON guards, and kept
 * out of the registry so it is never an MCP tool or RPC command. The signature is the authority, not the caller, so an
 * agent that posts here gets nothing without the owner's enclave key. Logs carry refusals and outcomes, never the proof.
 */
export function mountResolveProof(app: App, deps: ResolveProofDeps): void {
  app.post(RESOLVE_PROOF_PATH, async (c) => {
    const answer = await resolveProof(c.req.raw, deps);
    // An unread oversize body would otherwise hold the keep-alive socket until the server gives up draining it.
    if (answer.status === 413) c.header("connection", "close");
    return c.json(answer.body, answer.status);
  });
}

async function resolveProof(request: Request, deps: ResolveProofDeps): Promise<{ body: object; status: 200 | Status }> {
  if (!deps.keys.ok) return refuse(503, "owner keys not installed", { detail: deps.keys.refusal });
  const raw = await readCapped(request, MAX_PROOF_BODY_BYTES);
  if (raw === TOO_LARGE) return refuse(413, `proof body over ${MAX_PROOF_BODY_BYTES} bytes`);
  const body = parseBody(raw);
  if (body === undefined) return refuse(400, "body must be {statement, signature}, both base64url strings");
  try {
    const result = await applyProof(deps.host, { statementB64: body.statement, signatureB64: body.signature }, deps.keys.ring, { now: deps.now, aud: deps.aud, port: deps.port });
    if (!result.ok) {
      deps.log.warn({ refusal: result.refusal, detail: result.detail }, "refused an owner proof");
      return refuse(STATUS_OF[result.refusal] ?? 403, `owner proof refused: ${result.refusal}`, { refusal: result.refusal, detail: result.detail });
    }
    deps.log.info({ batchId: result.batchId, items: result.items.map(({ gate, outcome }) => ({ gate, outcome })) }, "applied an owner proof");
    return { body: { ok: true, batchId: result.batchId, items: result.items }, status: 200 };
  } catch (error) {
    deps.log.error({ err: error instanceof Error ? error.message : String(error) }, "applying an owner proof failed");
    return refuse(500, "applying the proof failed");
  }
}

function refuse(status: Status, message: string, extra: Record<string, unknown> = {}): { body: object; status: Status } {
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
async function readCapped(request: Request, max: number): Promise<string | typeof TOO_LARGE> {
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
