import { mkdirSync } from "node:fs";
import { isIPv6 } from "node:net";
import path from "node:path";
import {
  LOGIN_PATH,
  consoleLogger,
  ensureTokenFile,
  mintLoginCode,
  mountStaticApp,
  rotateTokenFile,
  startDaemon,
  type DaemonHandle,
  type Logger,
  type RemoteListenerOptions,
} from "@titan-design/daemon";
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

/**
 * The console's one daemon: its commands and, when asked, the built app, on loopback, plus the
 * LAN address behind auth when `lanHost` is set. The LAN is reached only through `remote`, which
 * gates every route, so no setting binds it without auth.
 */
export async function startConsoleDaemon(options: ConsoleDaemonOptions): Promise<DaemonHandle> {
  const { config, staticRoot } = options;
  const remote = lanListener(config);
  const sources = createSources(config);
  const { upstreams } = sources;
  return startDaemon({
    registry: createConsoleRegistry(sources),
    createContext,
    version: APP_VERSION,
    port: config.port,
    stateDir: config.stateDir,
    ...(remote ? { remote } : {}),
    // Targets only: /health must answer without waiting on an upstream.
    health: () => ({ upstreams: upstreams.map(({ id, target }) => ({ id, target })) }),
    mountRoutes: staticRoot ? (app) => mountStaticApp(app, { root: staticRoot }) : undefined,
    logger: options.logger ?? consoleLogger,
  });
}

/** Creates the token file on first run; an untrustworthy one throws here, before anything binds. */
function lanListener(config: ConsoleConfig): RemoteListenerOptions | null {
  if (config.lanHost === null) return null;
  ensureLanToken(config);
  return { host: config.lanHost, tokenFile: config.lanTokenPath, allowedHosts: config.lanNames };
}

/** Closes on SIGINT or SIGTERM, then runs `onClose` so a caller can stop what it started beside the daemon. */
export function closeOnSignal(handle: DaemonHandle, onClose: () => Promise<void> = async () => {}): void {
  const stop = (): void => {
    void onClose().finally(() => handle.close());
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

/** The LAN address a browser dials: the first LAN name, else the bound IP. */
export function lanOrigin(config: ConsoleConfig, port: number): string {
  const name = config.lanNames[0] ?? (config.lanHost && isIPv6(config.lanHost) ? `[${config.lanHost}]` : config.lanHost);
  if (!name) throw new Error("No LAN name to put in a link: set TITAN_CONSOLE_LAN_NAMES or TITAN_CONSOLE_HOST");
  return `http://${name}:${port}`;
}

/**
 * A one-time, ten-minute login link. Minting needs only the token file, never the running daemon,
 * so run it with the same TITAN_CONSOLE_* settings as the service. A daemon that restarts after
 * minting refuses the link.
 */
export function createLoginLink(config: ConsoleConfig, now: number = Date.now()): string {
  if (config.port === 0) throw new Error("TITAN_CONSOLE_PORT is 0, so there is no fixed port to put in a login link");
  const origin = lanOrigin(config, config.port);
  const code = mintLoginCode(ensureLanToken(config), now);
  return `${origin}${LOGIN_PATH}?code=${encodeURIComponent(code)}`;
}

/** Ends every session and voids every outstanding link; the running daemon re-reads the file, so it needs no restart. */
export function rotateLanToken(config: ConsoleConfig): void {
  ensureTokenDir(config);
  rotateTokenFile(config.lanTokenPath);
}

function ensureLanToken(config: ConsoleConfig): string {
  ensureTokenDir(config);
  return ensureTokenFile(config.lanTokenPath);
}

function ensureTokenDir(config: ConsoleConfig): void {
  mkdirSync(path.dirname(config.lanTokenPath), { recursive: true, mode: 0o700 });
}
