/**
 * The hono app: `/health`, `/version`, `/events` (SSE), and `POST /rpc/:name`.
 *
 * Pure by construction — it builds and returns a `Hono` without binding a port, so routes
 * are testable through `app.request()`. `daemon.ts` owns the lifecycle.
 */
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { EXIT, errorEnvelope, invokeCommand, type BaseContext } from "@titan-design/registry";
import type { EventHub } from "./events.js";
import { buildHealthPayload } from "./health.js";
import type { SurfaceOptions } from "./surface.js";

export interface HttpAppOptions<Ctx extends BaseContext = BaseContext> extends SurfaceOptions<Ctx> {
  /** Reported by `/health`. A thunk because `port: 0` is only resolved once bound. */
  port: () => number;
  /** Reported by `/health` and `/version`. */
  version: string;
  /** `Date.now()` at start; defaults to when the app was built. */
  startedAt?: number;
  /** When present, `/events` streams its broadcasts; otherwise only heartbeats. */
  hub?: EventHub;
  /**
   * Whether startup has finished. Until it has, `/health` answers 503: the port binds
   * before the pid file exists, so a caller treating a bound port as "ready" could find
   * the daemon healthy and then fail to look it up.
   */
  ready?: () => boolean;
  /** Product state merged into the `/health` payload. */
  health?: () => Record<string, unknown>;
  /** Hook for product-owned routes (a dashboard, static assets, extra endpoints). */
  mountRoutes?: (app: Hono) => void;
}

/** Interval between SSE keep-alive comments (ms). */
const HEARTBEAT_MS = 25_000;

export function buildHttpApp<Ctx extends BaseContext>(options: HttpAppOptions<Ctx>): Hono {
  const app = new Hono();
  const startedAt = options.startedAt ?? Date.now();

  app.get("/health", (c) => {
    if (options.ready && !options.ready()) return c.json({ ok: false, starting: true }, 503);
    const payload = buildHealthPayload({
      port: options.port(),
      version: options.version,
      startedAt,
      extension: options.health?.(),
    });
    return c.json(payload);
  });

  app.get("/version", (c) => c.json({ version: options.version }));
  registerEvents(app, options);
  registerRpc(app, options);
  options.mountRoutes?.(app);
  return app;
}

function registerEvents<Ctx extends BaseContext>(app: Hono, options: HttpAppOptions<Ctx>): void {
  app.get("/events", (c) =>
    streamSSE(c, async (stream) => {
      await stream.writeSSE({ event: "ready", data: "connected" });
      const unsubscribe = options.hub?.subscribe((message) => stream.writeSSE(message));
      stream.onAbort(() => unsubscribe?.());
      // Hold the connection open, emitting periodic heartbeats so proxies and dead-peer
      // detection keep the stream healthy until the client aborts.
      while (!stream.aborted) {
        await stream.sleep(HEARTBEAT_MS);
        if (stream.aborted) break;
        await stream.writeSSE({ event: "ping", data: String(Date.now()) });
      }
      unsubscribe?.();
    }),
  );
}

const INVALID_JSON = Symbol("invalid-json");

function registerRpc<Ctx extends BaseContext>(app: Hono, options: HttpAppOptions<Ctx>): void {
  app.post("/rpc/:name", async (c) => {
    const name = c.req.param("name");
    const cmd = options.registry.get(name);
    if (!cmd) return c.json(errorEnvelope(`Unknown command: ${name}`, EXIT.USAGE), 404);

    const rawArgs = await readJsonBody(c);
    if (rawArgs === INVALID_JSON) return c.json(errorEnvelope("Invalid JSON body", EXIT.USAGE), 400);

    const { envelope, exitCode } = await invokeCommand(cmd, rawArgs, options.createContext("http"), {
      invalidArgsCode: EXIT.DATAERR,
      formatError: options.formatError,
    });
    if (envelope.ok) return c.json(envelope);
    // DATAERR is the caller's fault whether it came from schema validation or the command.
    return c.json(envelope, exitCode === EXIT.DATAERR ? 400 : 500);
  });
}

/** Body is optional; an empty one means "no arguments". Reads text so no header is load-bearing. */
async function readJsonBody(c: Context): Promise<unknown> {
  let raw: string;
  try {
    raw = await c.req.text();
  } catch {
    return INVALID_JSON;
  }
  if (raw.trim() === "") return {};
  try {
    return JSON.parse(raw);
  } catch {
    return INVALID_JSON;
  }
}
