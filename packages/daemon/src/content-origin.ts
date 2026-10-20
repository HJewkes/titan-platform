/**
 * A content origin: a second port that serves only product routes, read-only, so untrusted
 * content (a PR's built Storybook, say) runs in an origin that is not the daemon's. Browsers
 * isolate origins by port, so script there cannot read the main origin's pages, and the main
 * listeners' guards refuse its `Origin` on every state-changing request.
 *
 * Cookies ignore port, so the main listener's session cookie reaches this origin too, and the
 * same gate accepts it: there is no second sign-in, and no sign-in route here at all.
 */
import { Hono, type MiddlewareHandler } from "hono";
import { EXIT, errorEnvelope } from "@titan-design/registry";
import { authGate, type DaemonAuth } from "./auth.js";
import type { RequestGuardOptions } from "./guards.js";
import { guardMiddleware } from "./http.js";

export interface ContentOriginOptions {
  /** Its own port on the loopback host and, with `remote`, the remote address. Pass 0 for an ephemeral port. */
  port: number;
  /** Product routes, mounted once per listener. Only GET and HEAD ever reach them. */
  mountRoutes: (app: Hono) => void;
}

export interface ContentAppOptions {
  mountRoutes: (app: Hono) => void;
  guards: RequestGuardOptions;
  port: () => number;
  /** Present on the remote listener: every path, `/auth/login` included, needs a session or bearer. */
  gate?: DaemonAuth;
}

const READ_METHODS = new Set(["GET", "HEAD"]);

/** No `/rpc`, `/events`, `/health`, `/mcp` or `/auth/*`: only what `mountRoutes` adds. */
export function buildContentApp(options: ContentAppOptions): Hono {
  const app = new Hono();
  app.use("*", readOnly());
  app.use("*", guardMiddleware(options.guards, options.port));
  if (options.gate) app.use("*", authGate(options.gate, { login: false }));
  options.mountRoutes(app);
  return app;
}

/** Ahead of the guard, so even a request that would pass it can never change state here. */
function readOnly(): MiddlewareHandler {
  return async (c, next) => {
    if (READ_METHODS.has(c.req.method)) return next();
    c.header("Allow", "GET, HEAD");
    return c.json(errorEnvelope(`Method ${c.req.method} is not allowed on the content origin`, EXIT.USAGE), 405);
  };
}
