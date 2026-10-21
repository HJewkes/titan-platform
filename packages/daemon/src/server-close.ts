import type { ServerType } from "@hono/node-server";

/**
 * `server.close` stops accepting new connections but resolves only once every open one ends,
 * and an MCP or `/events` client holds one open for its whole session. Without the forced
 * sweep the process outlives SIGTERM indefinitely and a restart finds the port still held.
 */
export function closeServer(server: ServerType, graceMs: number): Promise<void> {
  // The executor runs synchronously, so the server is already closing before either sweep —
  // node only destroys sockets on a server that has been told to close.
  const closed = new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  destroyConnections(server, "closeIdleConnections");
  const forced = setTimeout(() => destroyConnections(server, "closeAllConnections"), graceMs);
  forced.unref();
  return closed.finally(() => clearTimeout(forced));
}

type ConnectionSweep = "closeIdleConnections" | "closeAllConnections";

/** Http2 members of the `ServerType` union do not carry these; loopback daemons are http1. */
function destroyConnections(server: ServerType, sweep: ConnectionSweep): void {
  const close: unknown = Reflect.get(server, sweep);
  if (typeof close === "function") Reflect.apply(close, server, []);
}
