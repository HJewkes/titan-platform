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

/** Answers one `POST /rpc/<command>`; a throw becomes a failure envelope, with the error's numeric `code` when it has one. */
export type RpcAnswer = (command: string, args: Record<string, unknown>) => unknown;

async function answerRpc(req: IncomingMessage, command: string, rpc: RpcAnswer): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  try {
    return successEnvelope(rpc(command, JSON.parse(Buffer.concat(chunks).toString() || "{}") as Record<string, unknown>));
  } catch (err) {
    const code = err instanceof Error && "code" in err && typeof err.code === "number" ? err.code : EXIT.USAGE;
    return errorEnvelope(err instanceof Error ? err.message : String(err), code);
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
interface ClientTls {
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

const box = (type: string, ...parts: Buffer[]): Buffer => {
  const body = Buffer.concat(parts);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(8 + body.length);
  return Buffer.concat([size, Buffer.from(type, "latin1"), body]);
};

function trackHeader(width: number, height: number, quarterTurn: boolean): Buffer {
  const body = Buffer.alloc(84);
  const [a, b, c, d] = quarterTurn ? [0, 0x10000, -0x10000, 0] : [0x10000, 0, 0, 0x10000];
  body.writeInt32BE(a, 40);
  body.writeInt32BE(b, 44);
  body.writeInt32BE(c, 52);
  body.writeInt32BE(d, 56);
  body.writeInt32BE(0x40000000, 72);
  body.writeUInt32BE(width * 65536, 76);
  body.writeUInt32BE(height * 65536, 80);
  return box("tkhd", body);
}

const handlerBox = (handler: string) => box("hdlr", Buffer.alloc(8), Buffer.from(handler, "latin1"), Buffer.alloc(13));

interface SyntheticVideo {
  durationS?: number;
  width?: number;
  height?: number;
  audio?: boolean;
  /** Bytes in the media payload, so two otherwise equal fixtures can differ. */
  payload?: string;
}

/** An mp4 with only the boxes a header parser reads, and a `moov` after `mdat` as an unoptimised render has. */
export function syntheticMp4({ durationS = 2, width = 64, height = 36, audio = false, payload = "frames", quarterTurn = false }: SyntheticVideo & { quarterTurn?: boolean } = {}): Buffer {
  const movieHeader = Buffer.alloc(100);
  movieHeader.writeUInt32BE(1000, 12);
  movieHeader.writeUInt32BE(Math.round(durationS * 1000), 16);
  const video = box("trak", trackHeader(width, height, quarterTurn), box("mdia", handlerBox("vide")));
  const sound = box("trak", trackHeader(0, 0, false), box("mdia", handlerBox("soun")));
  const moov = box("moov", box("mvhd", movieHeader), video, ...(audio ? [sound] : []));
  return Buffer.concat([box("ftyp", Buffer.from("isom\0\0\0\0isom", "latin1")), box("mdat", Buffer.from(payload)), moov]);
}

/** An EBML element with an 8-byte size, which every reader accepts; null writes the unknown size a live recorder leaves. */
function ebml(id: number[], body: Buffer, size: number | null = body.length): Buffer {
  const length = Buffer.alloc(8, 0xff);
  if (size !== null) length.writeBigUInt64BE(BigInt(size) | (1n << 56n));
  else length[0] = 0x01;
  return Buffer.concat([Buffer.from(id), length, body]);
}

const ebmlUint = (id: number[], value: number) => {
  const body = Buffer.alloc(4);
  body.writeUInt32BE(value);
  return ebml(id, body);
};

/** A webm whose segment has the unknown size a MediaRecorder writes; `durationS: null` leaves Duration out as one does. */
export function syntheticWebm({ durationS = 2, width = 64, height = 36, audio = false, payload = "frames" }: Omit<SyntheticVideo, "durationS"> & { durationS?: number | null } = {}): Buffer {
  const duration = Buffer.alloc(8);
  duration.writeDoubleBE((durationS ?? 0) * 1000);
  const info = ebml([0x15, 0x49, 0xa9, 0x66], Buffer.concat([ebmlUint([0x2a, 0xd7, 0xb1], 1_000_000), ...(durationS === null ? [] : [ebml([0x44, 0x89], duration)])]));
  const videoTrack = ebml([0xae], Buffer.concat([ebmlUint([0x83], 1), ebml([0xe0], Buffer.concat([ebmlUint([0xb0], width), ebmlUint([0xba], height)]))]));
  const audioTrack = ebml([0xae], ebmlUint([0x83], 2));
  const tracks = ebml([0x16, 0x54, 0xae, 0x6b], Buffer.concat([videoTrack, ...(audio ? [audioTrack] : [])]));
  const cluster = ebml([0x1f, 0x43, 0xb6, 0x75], Buffer.from(payload));
  const header = ebml([0x1a, 0x45, 0xdf, 0xa3], ebml([0x42, 0x82], Buffer.from("webm")));
  return Buffer.concat([header, ebml([0x18, 0x53, 0x80, 0x67], Buffer.concat([info, tracks, cluster]), null)]);
}
