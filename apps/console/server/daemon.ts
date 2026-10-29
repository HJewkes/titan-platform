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
  type ContentOriginOptions,
  type DaemonHandle,
  type Logger,
  type RemoteListenerOptions,
} from "@titan-design/daemon";
import { perfCommands } from "./perf/commands.js";
import { createPerfRecorder } from "./perf/recorder.js";
import { readBuildInfo } from "./build-info.js";
import { LAN_NEEDS_TLS, type ConsoleConfig } from "./config.js";
import { relayUpstreams, startEventsRelay } from "./events-relay.js";
import { INBOX_DEPOSIT, INBOX_DEPOSIT_BODY_LIMIT } from "./inbox.js";
import { linkHost } from "./lan-cert.js";
import { APP_VERSION } from "./paths.js";
import type { ConsoleSources } from "./commands.js";
import type { ClassedCommand } from "./owner-guard.js";
import { consoleContextFor, createConsoleRegistry } from "./registry.js";
import { mountRoundMedia } from "./round-clip.js";
import type { LiveReader } from "./round-live.js";
import { mountStoryRoutes } from "./story-origin.js";
import { createSources } from "./upstreams.js";
import { mountVideoMedia } from "./videos.js";

export interface ConsoleDaemonOptions {
  config: ConsoleConfig;
  /** A built app to serve at `/`; the dev server serves the app itself and leaves this out. */
  staticRoot?: string;
  logger?: Logger;
  /** Classed commands served beside the console's reads; a test's stub owner-write comes in here. */
  extraCommands?: readonly ClassedCommand[];
}

/**
 * The console's one daemon: its commands and, when asked, the built app, on loopback, plus the
 * LAN address behind TLS and auth when `lanHost` is set. The LAN is reached only through `remote`,
 * which serves only HTTPS and gates every route, so no setting binds it in clear or without auth.
 */
export async function startConsoleDaemon(options: ConsoleDaemonOptions): Promise<DaemonHandle> {
  const { config, staticRoot } = options;
  const remote = lanListener(config);
  const logger = options.logger ?? consoleLogger;
  const ports = { console: config.port, story: config.storyPort ?? null };
  const sources = withStoryOrigin(createSources(config, logger), config, ports);
  const { upstreams } = sources;
  const build = readBuildInfo();
  const perf = createPerfRecorder({ dir: path.join(config.stateDir, "perf") });
  const commands = [...(options.extraCommands ?? []), ...Object.values(perfCommands(perf))];
  const handle = await startDaemon({
    registry: createConsoleRegistry(sources, commands),
    createContext: consoleContextFor(config.ownerWrites),
    version: APP_VERSION,
    port: config.port,
    stateDir: config.stateDir,
    ...(remote ? { remote } : {}),
    ...storyContentOrigin(config, ports),
    onRpc: (sample) => perf.record(sample),
    rpcBodyLimit: { perCommand: { [INBOX_DEPOSIT]: INBOX_DEPOSIT_BODY_LIMIT } },
    // Targets only: /health must answer without waiting on an upstream. `build` is what the self-updater checks after a restart.
    health: () => ({ upstreams: upstreams.map(({ id, target }) => ({ id, target })), build }),
    mountRoutes: (app) => mountRoutes(app, sources, staticRoot),
    logger,
  });
  Object.assign(ports, { console: handle.port, story: handle.contentPort ?? null });
  void sources.listeners?.sweep();
  const relay = startEventsRelay({ hub: handle.hub, upstreams: relayUpstreams(config), logger });
  const close = async (): Promise<void> => {
    await Promise.all([relay.close(), handle.close()]);
    await perf.close();
  };
  return { ...handle, close };
}

/** Media routes go ahead of the static app, whose `/*` would answer them with the page. */
function mountRoutes(app: Parameters<typeof mountStaticApp>[0], sources: ConsoleSources, staticRoot: string | undefined): void {
  if (sources.videos) mountVideoMedia(app, sources.videos);
  mountRoundMedia(app, sources.rounds);
  if (staticRoot) mountStaticApp(app, { root: staticRoot });
}

/** Bound ports, read per request: with port 0 they are known only once the daemon has bound them. */
interface BoundPorts {
  console: number;
  story: number | null;
}

/**
 * The story origin (TP-3793): stored Storybook builds on a port of their own, so story code never
 * runs as the console. It has the LAN listener's TLS pair and auth gate, and nothing but the story routes.
 */
function storyContentOrigin(config: ConsoleConfig, ports: BoundPorts): { contentOrigin?: ContentOriginOptions } {
  const { storybooksDir } = config;
  if (ports.story === null || storybooksDir === undefined) return {};
  const consoleOrigins = () => consolePageOrigins(config, ports.console);
  return { contentOrigin: { port: ports.story, mountRoutes: (app) => mountStoryRoutes(app, { storybooksDir, consoleOrigins }) } };
}

/** `rounds.get` names the story origin a page on that listener can frame: the LAN page gets the LAN one. */
function withStoryOrigin(sources: ConsoleSources, config: ConsoleConfig, ports: BoundPorts): ConsoleSources {
  const read = sources.rounds.live;
  if (ports.story === null || read === undefined) return sources;
  const storyOrigin = (remote: boolean): string | null => {
    if (ports.story === null) return null;
    return remote ? lanOrigin(config, ports.story) : `http://${LOOPBACK}:${ports.story}`;
  };
  const live: LiveReader = async (roundDir, manifest, remote = false) => {
    const found = await read(roundDir, manifest);
    return found && { ...found, origin: storyOrigin(remote) };
  };
  return { ...sources, rounds: { ...sources.rounds, live } };
}

const LOOPBACK = "127.0.0.1";

/** Every origin a console page is served from: loopback by address and by name, and each LAN name and the LAN address. */
function consolePageOrigins(config: ConsoleConfig, port: number): string[] {
  const loopback = [LOOPBACK, "localhost"].map((host) => `http://${host}:${port}`);
  if (config.lanHost === null) return loopback;
  const lanAddress = isIPv6(config.lanHost) ? `[${config.lanHost}]` : config.lanHost;
  return [...loopback, ...[...config.lanNames, lanAddress].map((host) => `https://${host}:${port}`)];
}

const SIGN_IN_HINT = "Ask the operator for a fresh sign-in link. It is minted on the host with titan-console login-link.";

/** Creates the token file on first run; an untrustworthy one throws here, before anything binds. */
function lanListener(config: ConsoleConfig): RemoteListenerOptions | null {
  if (config.lanHost === null) return null;
  if (config.lanTls === null) throw new Error(LAN_NEEDS_TLS);
  ensureLanToken(config);
  return { host: config.lanHost, tokenFile: config.lanTokenPath, allowedHosts: config.lanNames, tls: config.lanTls, signInHint: SIGN_IN_HINT };
}

/** Closes on SIGINT or SIGTERM, then runs `onClose` so a caller can stop what it started beside the daemon. */
export function closeOnSignal(handle: DaemonHandle, onClose: () => Promise<void> = async () => {}): void {
  const stop = (): void => {
    void onClose().finally(() => handle.close());
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

/** The HTTPS address a browser dials: the first LAN name, which the certificate covers, else the bound IP. */
export function lanOrigin(config: ConsoleConfig, port: number): string {
  const name = config.lanNames[0] ?? (config.lanHost && isIPv6(config.lanHost) ? `[${config.lanHost}]` : config.lanHost);
  if (!name) throw new Error("No LAN name to put in a link: set TITAN_CONSOLE_LAN_NAMES or TITAN_CONSOLE_HOST");
  return `https://${name}:${port}`;
}

/**
 * A one-time, ten-minute login link. Minting needs only the token file and the certificate, never
 * the running daemon, so run it with the same TITAN_CONSOLE_* settings as the service. A daemon
 * that restarts after minting refuses the link.
 */
export function createLoginLink(config: ConsoleConfig, now: number = Date.now()): string {
  if (config.port === 0) throw new Error("TITAN_CONSOLE_PORT is 0, so there is no fixed port to put in a login link");
  const origin = `https://${linkHost(config)}:${config.port}`;
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
