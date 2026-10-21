import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Logger } from "@titan-design/daemon";
import type { Db } from "@titan-design/store-sqlite";
import type { SourcesReader } from "../github-sources/mode.js";
import { BODY_TOO_LARGE, answerDelivery, type IngressAnswer, type IngressDeps, type IngressRequest, type Projector } from "./answer.js";
import { INGRESS_PATH, INGRESS_PORT, INGRESS_REQUEST_TIMEOUT_MS } from "./paths.js";
import type { TrackedWebhookSecret, WebhookSecretState } from "./secret.js";

/** Funnel reaches the listener through a local proxy, so nothing needs more than loopback. */
const LOOPBACK = "127.0.0.1";

export interface IngressListenerOptions {
  /** Defaults to 7411; 0 binds an ephemeral port. */
  port?: number;
  /** Caps the headers and the whole request; defaults to `INGRESS_REQUEST_TIMEOUT_MS`. */
  requestTimeoutMs?: number;
  /** Read on every request, so a config edit applies to the next delivery with no restart. */
  sources: SourcesReader;
  secret: TrackedWebhookSecret;
  project: Projector;
  db: Db;
  now?: () => number;
  log: Pick<Logger, "info" | "warn" | "error">;
}

interface IngressCounts {
  stored: number;
  duplicate: number;
  ignored: number;
  refused: number;
}

export interface IngressStatus {
  path: string;
  port: number;
  listening: boolean;
  /** Why the bind failed; serve keeps running on polling without the listener. */
  error?: string;
  secret: WebhookSecretState;
  lastDelivery?: { at: string; event?: string; status: number };
  counts: IngressCounts;
}

export interface IngressListener {
  readonly port: number;
  status(): IngressStatus;
  close(): Promise<void>;
}

/**
 * The webhook ingress on its own loopback port (TP-3100 §2.3). It does no Host or Origin check: the HMAC is the authority,
 * and the daemon's guards on 7410 would refuse the Funnel Host. A bind failure is reported in the status, never thrown.
 */
export async function listenIngress(options: IngressListenerOptions): Promise<IngressListener> {
  const timeoutMs = options.requestTimeoutMs ?? INGRESS_REQUEST_TIMEOUT_MS;
  const tally = deliveryTally(options.now ?? Date.now);
  const deps: IngressDeps = { sources: options.sources, secret: options.secret.read, project: options.project, db: options.db, now: options.now ?? Date.now, log: options.log };
  const server = createServer(serverTimeouts(timeoutMs), (req, res) => void handle(req, res, deps, tally));
  const error = await bind(server, options.port ?? INGRESS_PORT);
  if (error !== undefined) options.log.error({ port: options.port ?? INGRESS_PORT, err: error }, "webhook ingress could not bind; serve goes on without it");
  else server.on("error", (err) => options.log.error({ err: err.message }, "webhook ingress listener error"));
  const port = boundPort(server) ?? options.port ?? INGRESS_PORT;
  const status = (): IngressStatus => ({ path: INGRESS_PATH, port, listening: server.listening, ...(error !== undefined && { error }), secret: options.secret.state(), ...tally.status() });
  return { port, status, close: () => closeListener(server) };
}

/** Node enforces these only when it sweeps its connections, every 30 s by default, so the sweep runs at an eighth of the cap. */
function serverTimeouts(timeoutMs: number) {
  return { requestTimeout: timeoutMs, headersTimeout: timeoutMs, connectionsCheckingInterval: Math.max(50, Math.floor(timeoutMs / 8)) };
}

function bind(server: Server, port: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    const onError = (err: Error): void => void (server.off("listening", onListening), resolve(err.message));
    const onListening = (): void => void (server.off("error", onError), resolve(undefined));
    server.once("error", onError).once("listening", onListening).listen(port, LOOPBACK);
  });
}

function boundPort(server: Server): number | undefined {
  const address = server.address();
  return address !== null && typeof address === "object" ? address.port : undefined;
}

function closeListener(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

type DeliveryTally = ReturnType<typeof deliveryTally>;

function deliveryTally(now: () => number) {
  const counts: IngressCounts = { stored: 0, duplicate: 0, ignored: 0, refused: 0 };
  let lastDelivery: IngressStatus["lastDelivery"];
  const record = (event: string | undefined, answer: Pick<IngressAnswer, "status" | "body">): void => {
    counts[outcomeOf(answer)] += 1;
    lastDelivery = { at: new Date(now()).toISOString(), ...(event !== undefined && { event }), status: answer.status };
  };
  return { record, status: () => ({ ...(lastDelivery && { lastDelivery }), counts: { ...counts } }) };
}

function outcomeOf({ status, body }: Pick<IngressAnswer, "status" | "body">): keyof IngressCounts {
  if (status === 200 && body.inserted === true) return "stored";
  if (status === 200 && body.by !== undefined) return "duplicate";
  if (status === 202 || (status === 200 && body.ping === true)) return "ignored";
  return "refused";
}

/** A body stream that dies mid-read has no one left to answer, so the socket is dropped. */
async function handle(req: IncomingMessage, res: ServerResponse, deps: IngressDeps, tally: DeliveryTally): Promise<void> {
  const event = typeof req.headers["x-github-event"] === "string" ? req.headers["x-github-event"] : undefined;
  try {
    const answer = await answerDelivery(toIngressRequest(req), deps);
    tally.record(event, answer);
    res.writeHead(answer.status, { "content-type": "application/json", ...answer.headers }).end(JSON.stringify(answer.body));
  } catch (err) {
    tally.record(event, { status: 408, body: {} });
    deps.log.warn({ event, err: err instanceof Error ? err.message : String(err) }, "webhook delivery ended before its body");
    res.destroy();
  }
}

function toIngressRequest(req: IncomingMessage): IngressRequest {
  const headers = Object.fromEntries(Object.entries(req.headers).map(([name, value]) => [name, Array.isArray(value) ? value.join(", ") : (value ?? "")]));
  return { method: req.method ?? "", path: (req.url ?? "").split("?")[0] ?? "", headers, body: (max) => readCapped(req, max) };
}

/** Stops reading at the cap, so an oversized sender costs at most `max` bytes of memory before the 413. */
function readCapped(req: IncomingMessage, max: number): Promise<Uint8Array | typeof BODY_TOO_LARGE> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size <= max) return void chunks.push(chunk);
      req.off("data", onData).pause();
      resolve(BODY_TOO_LARGE);
    };
    req.on("data", onData);
    req.once("end", () => resolve(Buffer.concat(chunks)));
    req.once("error", reject);
    req.once("close", () => reject(new Error("request closed before its body ended")));
  });
}
