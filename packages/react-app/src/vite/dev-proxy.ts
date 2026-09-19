import type { IncomingMessage } from "node:http";
import type { ProxyOptions } from "vite";
import { EVENTS_PATH, HEALTH_PATH, RPC_PREFIX, VERSION_PATH } from "@titan-design/rpc-protocol";

/** The daemon's own loopback names; the dev server must be reached by one of them to speak for the page. */
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Anchored on purpose: a bare "/rpc" key is a prefix match that also captures a source
 * module such as "/rpc.ts", which then fails to load and blanks the page.
 */
export const PROXIED_ROUTES = [
  `^${RPC_PREFIX}`,
  `^${EVENTS_PATH}(?:\\?|$)`,
  `^${HEALTH_PATH}(?:\\?|$)`,
  `^${VERSION_PATH}(?:\\?|$)`,
];

export interface ForwardedHeaders {
  host?: string;
  origin?: string;
}

/**
 * The Host and Origin the daemon should see for one dev-server request. A same-origin
 * request to a loopback dev server becomes a same-origin request to the daemon; anything
 * else is forwarded untouched, so the daemon's own guards refuse it exactly as they would
 * refuse it directly. Content-Type is never touched.
 */
export function daemonHeaders(incoming: ForwardedHeaders, daemon: URL): ForwardedHeaders {
  if (!incoming.host || !isLoopbackHost(incoming.host)) return {};
  const sameOrigin = incoming.origin === `http://${incoming.host}` || incoming.origin === `https://${incoming.host}`;
  return sameOrigin ? { host: daemon.host, origin: daemon.origin } : { host: daemon.host };
}

export function isLoopbackHost(host: string): boolean {
  const hostname = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0]!;
  return LOOPBACK_HOSTNAMES.has(hostname.toLowerCase());
}

/** Vite `server.proxy` entries that forward the daemon's routes to `daemonUrl`. */
export function daemonProxy(daemonUrl: string): Record<string, ProxyOptions> {
  const daemon = new URL(daemonUrl);
  const options: ProxyOptions = {
    target: daemon.origin,
    // Host is rewritten by hand below, only for loopback requests, so the daemon still judges the rest.
    changeOrigin: false,
    configure: (proxy) => {
      proxy.on("proxyReq", (proxyReq, req: IncomingMessage) => {
        const headers = daemonHeaders({ host: req.headers.host, origin: req.headers.origin }, daemon);
        if (headers.host) proxyReq.setHeader("host", headers.host);
        if (headers.origin) proxyReq.setHeader("origin", headers.origin);
      });
    },
  };
  return Object.fromEntries(PROXIED_ROUTES.map((route) => [route, options]));
}
