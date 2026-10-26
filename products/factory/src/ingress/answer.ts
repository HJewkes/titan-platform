import type { Logger } from "@titan-design/daemon";
import { TokenFileError } from "@titan-design/daemon";
import type { Db } from "@titan-design/store-sqlite";
import { appendEvent, type IdentityEvent, type TransitionEvent } from "../event-log/event-log.js";
import type { SourcesReader } from "../github-sources/mode.js";
import { INGRESS_PATH, MAX_INGRESS_BODY_BYTES } from "./paths.js";
import { verifySignature } from "./signature.js";

export const BODY_TOO_LARGE = "too-large";

/** A listener passes a reader so the kill switch answers before one byte is read; a harness passes the bytes. */
type IngressBody = Uint8Array | ((max: number) => Promise<Uint8Array | typeof BODY_TOO_LARGE>);

export interface IngressRequest {
  method: string;
  path: string;
  /** Names in any case. */
  headers: Record<string, string>;
  body: IngressBody;
}

export interface IngressAnswer {
  status: number;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
}

/** Throws `TokenFileError` when the secret file is missing or refused. Production wraps `trackTokenFile(webhookSecretPath(env))`. */
export type WebhookSecret = () => string;

type WithoutTransport<T> = T extends unknown ? Omit<T, "source" | "deliveryId" | "observedAt"> : never;
type ProjectedEvent = WithoutTransport<IdentityEvent | TransitionEvent>;

/** One delivery gives one event or none: `delivery_id` is unique per row. */
export type Projector = (event: string, payload: unknown) => ProjectedEvent | "ignored";

export interface IngressDeps {
  sources: SourcesReader;
  secret: WebhookSecret;
  project: Projector;
  db: Db;
  now: () => number;
  log: Pick<Logger, "info" | "warn" | "error">;
}

interface Delivery {
  event: string;
  guid: string;
  signature: string;
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EVENT_NAME = /^[a-z_]+$/;

const refuse = (status: number, error: string, headers?: Record<string, string>): IngressAnswer => ({ status, body: { error }, ...(headers && { headers }) });

function header(request: IngressRequest, name: string): string | undefined {
  return Object.entries(request.headers).find(([key]) => key.toLowerCase() === name)?.[1];
}

function readDelivery(request: IngressRequest): Delivery | undefined {
  const event = header(request, "x-github-event") ?? "";
  const guid = header(request, "x-github-delivery") ?? "";
  const signature = header(request, "x-hub-signature-256") ?? "";
  if (!EVENT_NAME.test(event) || !GUID.test(guid) || signature === "") return undefined;
  return { event, guid, signature };
}

/** Steps 2-5 of TP-3100 §2.1: everything that can be refused from the request line and headers alone. */
function refuseFraming(request: IngressRequest): IngressAnswer | Delivery {
  if (request.path !== INGRESS_PATH) return refuse(404, "not found");
  if (request.method !== "POST") return refuse(405, "method not allowed", { allow: "POST" });
  const contentType = header(request, "content-type")?.split(";")[0]?.trim().toLowerCase();
  if (contentType !== "application/json") return refuse(415, "content-type must be application/json");
  return readDelivery(request) ?? refuse(400, "X-GitHub-Event, X-GitHub-Delivery and X-Hub-Signature-256 are required");
}

async function readBody(body: IngressBody): Promise<Uint8Array | typeof BODY_TOO_LARGE> {
  if (typeof body === "function") return body(MAX_INGRESS_BODY_BYTES);
  return body.byteLength > MAX_INGRESS_BODY_BYTES ? BODY_TOO_LARGE : body;
}

function readSecret(deps: IngressDeps, delivery: Delivery): string | IngressAnswer {
  try {
    return deps.secret();
  } catch (error) {
    const problem = error instanceof TokenFileError ? error.problem : "unreadable";
    deps.log.warn({ delivery: delivery.guid, problem }, "webhook secret unavailable");
    return refuse(503, "webhook secret unavailable");
  }
}

function parseJson(raw: Uint8Array): { value: unknown } | undefined {
  try {
    return { value: JSON.parse(Buffer.from(raw).toString("utf8")) as unknown };
  } catch {
    return undefined;
  }
}

/** Steps 6-9: the body and the secret are read only here, after the kill switch and the framing checks. */
async function authenticate(request: IngressRequest, delivery: Delivery, deps: IngressDeps): Promise<IngressAnswer | { payload: unknown }> {
  const raw = await readBody(request.body);
  if (raw === BODY_TOO_LARGE) return refuse(413, `body over ${MAX_INGRESS_BODY_BYTES} bytes`, { connection: "close" });
  const secret = readSecret(deps, delivery);
  if (typeof secret !== "string") return secret;
  if (!verifySignature(secret, raw, delivery.signature)) return refuse(401, "signature mismatch");
  const parsed = parseJson(raw);
  return parsed === undefined ? refuse(400, "body is not JSON") : { payload: parsed.value };
}

function project(delivery: Delivery, payload: unknown, deps: IngressDeps): ProjectedEvent | IngressAnswer | "ignored" {
  try {
    return deps.project(delivery.event, payload);
  } catch (error) {
    deps.log.warn({ delivery: delivery.guid, event: delivery.event, err: error instanceof Error ? error.message : String(error) }, "webhook projection failed");
    return refuse(422, "payload does not project");
  }
}

/** Step 14 answers 503 on any append error, a busy lock included, so GitHub retries a delivery that was never stored. */
function store(projected: ProjectedEvent, delivery: Delivery, deps: IngressDeps): IngressAnswer {
  try {
    const event = { ...projected, source: "webhook", deliveryId: `webhook:${delivery.guid}`, observedAt: new Date(deps.now()).toISOString() } as const;
    const result = appendEvent(deps.db, event);
    deps.log.info({ delivery: delivery.guid, event: delivery.event, seq: result.seq, inserted: result.inserted }, "webhook delivery stored");
    return { status: 200, body: result.inserted ? { seq: result.seq, inserted: true } : { seq: result.seq, by: result.by } };
  } catch (error) {
    deps.log.error({ delivery: delivery.guid, event: delivery.event, err: error instanceof Error ? error.message : String(error) }, "webhook append failed");
    return refuse(503, "event log unavailable");
  }
}

/**
 * The in-process ingress entry (TP-3100 §2.1): the S3 listener adapts to it and a harness calls it with no socket. Parse-only
 * (R28): it verifies, projects and appends, and nothing it imports can act on a payload.
 */
export async function answerDelivery(request: IngressRequest, deps: IngressDeps): Promise<IngressAnswer> {
  if (deps.sources().effective !== "webhook") return refuse(404, "ingress off");
  const delivery = refuseFraming(request);
  if ("status" in delivery) return delivery;
  const authed = await authenticate(request, delivery, deps);
  if ("status" in authed) return authed;
  if (delivery.event === "ping") return { status: 200, body: { ok: true, ping: true } };
  const projected = project(delivery, authed.payload, deps);
  if (projected === "ignored") return { status: 202, body: { ignored: true } };
  if ("status" in projected) return projected;
  return store(projected, delivery, deps);
}
