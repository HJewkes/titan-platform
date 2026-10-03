import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeDaemon {
  port: number;
  close(): Promise<void>;
}

const closeServer = (server: Server): Promise<void> => new Promise((resolve) => server.close(() => resolve()));

/** A loopback server that answers `GET /health` the way a titan daemon does, and 404 for anything else. */
export async function startFakeDaemon(health: Record<string, unknown>): Promise<FakeDaemon> {
  const server = createServer((req, res) => {
    const found = req.url === "/health";
    res.writeHead(found ? 200 : 404, { "content-type": "application/json" });
    res.end(JSON.stringify(found ? health : { ok: false }));
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
