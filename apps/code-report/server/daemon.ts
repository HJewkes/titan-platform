import { tmpdir } from "node:os";
import path from "node:path";
import { consoleLogger, mountStaticApp, startDaemon, type DaemonHandle } from "@titan-design/daemon";
import { DAEMON_PORT } from "./paths.js";
import { createContext, createReportRegistry } from "./registry.js";

export interface ReportDaemonOptions {
  /** A built app to serve at `/`; the dev server serves the app itself and leaves this out. */
  staticRoot?: string;
}

/** The code-read commands over titan-platform's own index on loopback, plus the built app when asked. */
export async function startReportDaemon(options: ReportDaemonOptions = {}): Promise<DaemonHandle> {
  const { registry } = await createReportRegistry();
  const { staticRoot } = options;
  return startDaemon({
    registry,
    createContext,
    version: "0.0.0",
    port: DAEMON_PORT,
    // Per port, so a second report on another port never trips over this one's pid file.
    stateDir: path.join(tmpdir(), `code-report-daemon-${DAEMON_PORT}`),
    toolPrefix: "codewatch__",
    mountRoutes: staticRoot ? (app) => mountStaticApp(app, { root: staticRoot }) : undefined,
    logger: consoleLogger,
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
