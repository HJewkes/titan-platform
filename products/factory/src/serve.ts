import { createRequire } from "node:module";
import { dirname } from "node:path";
import { consoleLogger, startDaemon, type DaemonHandle, type EventHub, type Logger, type StartDaemonOptions } from "@titan-design/daemon";
import { createRegistry, type BaseContext } from "@titan-design/registry";
import type { WorkflowStatus } from "@titan-design/workflow";
import { openFactoryHost, type FactoryHost, type FactoryHostOptions } from "./host.js";

export const FACTORY_PORT = 7410;
/** Empty so registered commands keep their own names: `shepherd.register` becomes `shepherd__register`, not `factory__shepherd__register`. */
export const TOOL_PREFIX = "";
const DEFAULT_LEASE_MS = 30_000;
const STATUSES: readonly WorkflowStatus[] = ["running", "paused", "cancelling", "recovery_required", "completed", "failed", "cancelled"];
const { version: FACTORY_VERSION } = createRequire(import.meta.url)("../package.json") as { version: string };

export interface FactoryServerOptions extends FactoryHostOptions {
  /** Holds the daemon pid file, the one-server-per-directory lock; defaults to the database's directory. */
  stateDir?: string;
  /** Defaults to 7410; 0 binds an ephemeral port. */
  port?: number;
  /** Bind address; defaults to 127.0.0.1. */
  hostname?: string;
  logger?: Logger;
}

export interface FactoryContext extends BaseContext {
  host: FactoryHost;
}

export interface FactoryServer {
  readonly port: number;
  readonly host: FactoryHost;
  readonly hub: EventHub;
  /** Stop the sweep and the daemon, then release every lease and close the database. Idempotent. */
  close(): Promise<void>;
}

/** Owns the factory database for as long as it runs, so runs outlive the shell that started them. */
export async function startFactoryServer(options: FactoryServerOptions): Promise<FactoryServer> {
  const host = openFactoryHost(options);
  let daemon: DaemonHandle;
  try {
    daemon = await startDaemon(daemonOptions(host, options));
  } catch (err) {
    host.close();
    throw err;
  }
  const sweep = startAdoptionSweep(host, options.leaseMs ?? DEFAULT_LEASE_MS, options.logger ?? consoleLogger);
  await sweep.tick();
  let closing: Promise<void> | null = null;
  const close = async (): Promise<void> => {
    await sweep.stop();
    await daemon.close();
    host.close();
  };
  return { port: daemon.port, host, hub: daemon.hub, close: () => (closing ??= close()) };
}

/** Start, then run until SIGTERM or SIGINT, then close. Resolves after shutdown completes. */
export async function serveFactoryUntilSignal(options: FactoryServerOptions): Promise<void> {
  const server = await startFactoryServer(options);
  const signal = await new Promise<NodeJS.Signals>((resolve) => {
    process.once("SIGTERM", resolve);
    process.once("SIGINT", resolve);
  });
  (options.logger ?? consoleLogger).info({ signal }, "shutting down");
  await server.close();
}

function daemonOptions(host: FactoryHost, options: FactoryServerOptions): StartDaemonOptions<FactoryContext> {
  return {
    registry: createRegistry<FactoryContext>(),
    createContext: () => ({ warnings: [], format: "json", host }),
    version: FACTORY_VERSION,
    stateDir: options.stateDir ?? dirname(options.dbPath),
    port: options.port ?? FACTORY_PORT,
    host: options.hostname,
    toolPrefix: TOOL_PREFIX,
    mcpName: "titan-factory",
    health: () => factoryHealth(host),
    logger: options.logger,
  };
}

export function factoryHealth(host: FactoryHost): Record<string, unknown> {
  const runs = Object.fromEntries(STATUSES.map((status) => [status, 0])) as Record<WorkflowStatus, number>;
  for (const run of host.runtime.list([...STATUSES])) runs[run.status] += 1;
  return { runs, pendingGates: host.pendingGates().length };
}

interface AdoptionSweep {
  tick(): Promise<void>;
  stop(): Promise<void>;
}

/** Picks up runs whose owning process exited without releasing: their lease lapses, and the next tick claims them. */
function startAdoptionSweep(host: FactoryHost, everyMs: number, log: Logger): AdoptionSweep {
  let inFlight: Promise<void> | null = null;
  const tick = (): Promise<void> =>
    (inFlight ??= host
      .adopt()
      .then((ids) => void (ids.length > 0 && log.info({ runs: ids }, "adopted runs")))
      .catch((err: unknown) => log.error({ err }, "adoption sweep failed"))
      .finally(() => (inFlight = null)));
  const timer = setInterval(() => void tick(), everyMs);
  timer.unref();
  return {
    tick,
    stop: async () => {
      clearInterval(timer);
      await inFlight;
    },
  };
}
