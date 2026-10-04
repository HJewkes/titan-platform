import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
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
  brokerUptimeMs?: number;
}

/** A loopback agent-chat broker: `/api/sessions` and `/api/history` behind the token header, 401 without it. */
export async function startFakeBroker(data: FakeBrokerData): Promise<FakeDaemon> {
  const server = createServer((req, res) => {
    const route = (req.url ?? "").split("?")[0];
    const authorized = req.headers["x-agent-chat-token"] === data.token;
    const body =
      route === "/api/sessions" ? { sessions: data.sessions, brokerUptimeMs: data.brokerUptimeMs ?? 60_000 } : route === "/api/history" ? { items: data.items } : null;
    res.writeHead(!authorized ? 401 : body ? 200 : 404, { "content-type": "application/json" });
    res.end(JSON.stringify(authorized && body ? body : { error: "nope" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  // A request abandoned mid-Promise.all leaves a keep-alive socket that would hold close() open.
  const close = (): Promise<void> => {
    server.closeAllConnections();
    return closeServer(server);
  };
  return { port: (server.address() as AddressInfo).port, close };
}
