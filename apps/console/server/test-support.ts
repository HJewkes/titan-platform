import { execFileSync } from "node:child_process";
import { chmodSync, readFileSync } from "node:fs";
import { createServer, request, type IncomingMessage, type Server } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type AddressInfo } from "node:net";
import path from "node:path";
import { SESSION_COOKIE } from "@titan-design/daemon";
import { EXIT, errorEnvelope, successEnvelope } from "@titan-design/registry";

const RPC_PREFIX = "/rpc/";

export interface FakeDaemon {
  port: number;
  close(): Promise<void>;
}

const closeServer = (server: Server): Promise<void> => new Promise((resolve) => server.close(() => resolve()));

/** Answers one `POST /rpc/<command>`; a throw becomes a failure envelope. */
export type RpcAnswer = (command: string, args: Record<string, unknown>) => unknown;

async function answerRpc(req: IncomingMessage, command: string, rpc: RpcAnswer): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  try {
    return successEnvelope(rpc(command, JSON.parse(Buffer.concat(chunks).toString() || "{}") as Record<string, unknown>));
  } catch (err) {
    return errorEnvelope(err instanceof Error ? err.message : String(err), EXIT.USAGE);
  }
}

/** A loopback server that answers `GET /health` the way a titan daemon does, `POST /rpc/<command>` when given `rpc`, and 404 for anything else. */
export async function startFakeDaemon(health: Record<string, unknown>, rpc?: RpcAnswer): Promise<FakeDaemon> {
  const server = createServer((req, res) => {
    const send = (status: number, body: unknown): void => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const command = req.method === "POST" && req.url?.startsWith(RPC_PREFIX) ? decodeURIComponent(req.url.slice(RPC_PREFIX.length)) : undefined;
    if (command !== undefined && rpc) void answerRpc(req, command, rpc).then((envelope) => send(200, envelope));
    else if (req.url === "/health") send(200, health);
    else send(404, { ok: false });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: (server.address() as AddressInfo).port, close: () => closeServer(server) };
}

/** A loopback port nothing listens on: bound once, then released. */
export async function closedPort(): Promise<number> {
  const daemon = await startFakeDaemon({});
  await daemon.close();
  return daemon.port;
}

export interface FakeBrokerData {
  token: string;
  sessions: unknown[];
  items: unknown[];
  queue?: unknown[];
  brokerUptimeMs?: number;
}

export interface FakeBroker extends FakeDaemon {
  /** Every request as `METHOD url`, so a test can prove a read never wrote. */
  requests: string[];
}

function brokerBody(route: string | undefined, data: FakeBrokerData): unknown {
  if (route === "/api/sessions") return { sessions: data.sessions, brokerUptimeMs: data.brokerUptimeMs ?? 60_000 };
  if (route === "/api/history") return { items: data.items };
  if (route === "/api/queue") return { items: data.queue ?? [] };
  return null;
}

/** A loopback agent-chat broker: `/api/sessions`, `/api/history` and `/api/queue` behind the token header, 401 without it. */
export async function startFakeBroker(data: FakeBrokerData): Promise<FakeBroker> {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    const authorized = req.headers["x-agent-chat-token"] === data.token;
    const body = brokerBody((req.url ?? "").split("?")[0], data);
    res.writeHead(!authorized ? 401 : body ? 200 : 404, { "content-type": "application/json" });
    res.end(JSON.stringify(authorized && body ? body : { error: "nope" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  // A request abandoned mid-Promise.all leaves a keep-alive socket that would hold close() open.
  const close = (): Promise<void> => {
    server.closeAllConnections();
    return closeServer(server);
  };
  return { port: (server.address() as AddressInfo).port, close, requests };
}

export interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** What an HTTPS request trusts: the test certificate, and the name to verify it against. */
export interface ClientTls {
  ca: string;
  servername: string;
}

/** A raw request, so a test sets the Host and Origin headers that fetch would fill in itself. HTTPS when `tls` is given. */
export function send(address: string, port: number, method: string, route: string, headers: Record<string, string> = {}, body?: string, tls?: ClientTls): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const options = { host: address, port, path: route, method, headers };
    const onResponse = (res: IncomingMessage): void => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    };
    const req = tls ? httpsRequest({ ...options, ...tls }, onResponse) : request(options, onResponse);
    req.on("error", reject);
    req.end(body);
  });
}

export function sessionCookie(reply: Reply): string | undefined {
  const cookies = [reply.headers["set-cookie"] ?? []].flat();
  return cookies.find((cookie) => cookie.startsWith(`${SESSION_COOKIE}=`));
}

export interface SelfSignedPair {
  certFile: string;
  keyFile: string;
  /** The PEM certificate, for a client's `ca` option. */
  cert: string;
}

/** A one-day self-signed pair in `dir` covering each DNS name and IP, the key at 0600: what `tailscale cert` leaves, for a test. */
export function writeSelfSignedCert(dir: string, names: readonly string[]): SelfSignedPair {
  const certFile = path.join(dir, "lan.crt");
  const keyFile = path.join(dir, "lan.key");
  const san = names.map((name) => (isIP(name) ? `IP:${name}` : `DNS:${name}`)).join(",");
  execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", keyFile, "-out", certFile, "-days", "1", "-subj", `/CN=${names[0]}`, "-addext", `subjectAltName=${san}`], { stdio: "ignore" });
  chmodSync(keyFile, 0o600);
  return { certFile, keyFile, cert: readFileSync(certFile, "utf8") };
}
