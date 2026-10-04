import { consoleLogger, mountStaticApp, startDaemon, type DaemonHandle, type Logger } from "@titan-design/daemon";
import type { ConsoleConfig } from "./config.js";
import { APP_VERSION } from "./paths.js";
import { createConsoleRegistry, createContext } from "./registry.js";
import { createSources } from "./upstreams.js";

export interface ConsoleDaemonOptions {
  config: ConsoleConfig;
  /** A built app to serve at `/`; the dev server serves the app itself and leaves this out. */
  staticRoot?: string;
  logger?: Logger;
}

/** The console's one daemon: its commands and, when asked, the built app, on loopback only. */
export async function startConsoleDaemon(options: ConsoleDaemonOptions): Promise<DaemonHandle> {
  const { config, staticRoot } = options;
  const sources = createSources(config);
  const { upstreams } = sources;
  return startDaemon({
    registry: createConsoleRegistry(sources),
    createContext,
    version: APP_VERSION,
    port: config.port,
    stateDir: config.stateDir,
    // Targets only: /health must answer without waiting on an upstream.
    health: () => ({ upstreams: upstreams.map(({ id, target }) => ({ id, target })) }),
    mountRoutes: staticRoot ? (app) => mountStaticApp(app, { root: staticRoot }) : undefined,
    logger: options.logger ?? consoleLogger,
  });
}

/** Closes on SIGINT or SIGTERM, then runs `onClose` so a caller can stop what it started beside the daemon. */
export function closeOnSignal(handle: DaemonHandle, onClose: () => Promise<void> = async () => {}): void {
  const stop = (): void => {
    void onClose().finally(() => handle.close());
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
