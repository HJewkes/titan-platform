/** Where the loopback server listens, and the readiness gate an inherited socket needs. */
import { createAdaptorServer, serve, type ServerType } from "@hono/node-server";
import type { Hono } from "hono";

/** An inherited socket, or the address to bind. */
export type ListenTarget = { fd: number } | { hostname: string; port: number };

export type ServeOptions = Parameters<typeof serve>[0];

export function listenOn(options: ServeOptions, target: ListenTarget, onListening: () => void): ServerType {
  if ("port" in target) return serve({ ...options, hostname: target.hostname, port: target.port }, onListening);
  const server = createAdaptorServer(options);
  server.listen({ fd: target.fd }, onListening);
  return server;
}

interface ReadyLatch {
  isOpen: () => boolean;
  opened: Promise<void>;
  open: () => void;
}

export function readyLatch(): ReadyLatch {
  let isOpen = false;
  let resolve!: () => void;
  const opened = new Promise<void>((r) => (resolve = r));
  const open = (): void => {
    isOpen = true;
    resolve();
  };
  return { isOpen: () => isOpen, opened, open };
}

/**
 * Clients queued on an inherited socket while no process listened reach this one the moment
 * it listens, before the pid file exists. Holding them until it does turns what would be a 503
 * "starting" into a few more milliseconds of the wait they were already in.
 */
export function holdUntil(fetch: Hono["fetch"], opened: Promise<void>): Hono["fetch"] {
  return async (...args) => {
    await opened;
    return fetch(...args);
  };
}
