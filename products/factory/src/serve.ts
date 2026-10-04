import { createRequire } from "node:module";
import { dirname } from "node:path";
import { consoleLogger, startDaemon, type DaemonHandle, type EventHub, type Logger, type StartDaemonOptions } from "@titan-design/daemon";
import { routedRunner, type RoutedRunner, type WorkflowStatus } from "@titan-design/workflow";
import { behindMain, type BehindMain } from "./behind-main.js";
import { buildSha } from "./build-info.js";
import { factoryStateDir } from "./config.js";
import { readLastDeploy } from "./deploy-ports.js";
import { githubHealth, type GithubHealth } from "./github-health.js";
import { busyRuns } from "./restart-drain.js";
import { openFactoryHost, type FactoryHost, type FactoryHostOptions } from "./host.js";
import { createFactoryRegistry, factoryContext, type FactoryContext } from "./registry.js";
import type { ShepherdServices } from "./shepherd/commands.js";
import { GONE_SWEEP_MS, endRunsGoneElsewhere } from "./shepherd/gone-elsewhere.js";
import { supersedeMovedGates } from "./shepherd/head-moved.js";
import { recheckHeld, resyncShepherd } from "./shepherd/resync.js";
import { bindCarryStateDir } from "./shepherd/tree-carry.js";
import { sweepReviewCheckouts, type ReviewCheckoutSweepDeps } from "./shepherd/review-checkout-sweep.js";
import { RELEASE_SWEEP_MS, sweepVersionPackages } from "./shepherd/version-packages.js";

export type { FactoryContext } from "./registry.js";

export const FACTORY_PORT = 7410;
/** Empty so registered commands keep their own names: `shepherd.register` becomes `shepherd__register`, not `factory__shepherd__register`. */
export const TOOL_PREFIX = "";
const DEFAULT_LEASE_MS = 30_000;
const CHECKOUT_SWEEP_MS = 3_600_000;
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
  /** How often runs waiting on a gate have their PR checked for a merge or close elsewhere; defaults to 5 minutes. */
  goneSweepMs?: number;
  /** How often the Version Packages sweep runs; defaults to `RELEASE_SWEEP_MS`. */
  releaseSweepMs?: number;
  /** Replaces the `gh api rate_limit` probe behind health's `github` field; tests stub it. */
  github?: GithubHealth;
  /** Replaces the baked-in build sha behind health's `build` field; tests inject it. */
  build?: { sha: string; behindMain?: BehindMain };
  /** Where health's `lastDeploy` reads deploy.json; defaults to the XDG state dir the deployer writes. */
  deployStateDir?: string;
  /** Resync Shepherd's runs and gates with GitHub before the first adoption; defaults to true. */
  resyncOnStart?: boolean;
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
  const github = options.github ?? githubHealth();
  void github.refresh();
  const build = buildHealth(options);
  let daemon: DaemonHandle;
  try {
    daemon = await startDaemon(daemonOptions(host, options, github, build));
  } catch (err) {
    host.close();
    throw err;
  }
  const unbindCarry = bindCarryStateDir(stateDirOf(options));
  const log = options.logger ?? consoleLogger;
  const services = options.routes.shepherd;
  const held = new Set<string>();
  if (services && options.resyncOnStart !== false) await resync(host, services, log, held);
  const sweep = startSweep(() => adopt(host, services, held, log), options.leaseMs ?? DEFAULT_LEASE_MS, "adoption sweep", log);
  await sweep.tick();
  const goneSweep = services && startSweep(() => endGone(host, services, log), options.goneSweepMs ?? GONE_SWEEP_MS, "merged-elsewhere and head-moved sweep", log);
  await goneSweep?.tick();
  const releaseSweep = services && startSweep(() => sweepReleases(host, services, log), options.releaseSweepMs ?? RELEASE_SWEEP_MS, "version packages sweep", log);
  const checkoutSweep = services && startSweep(() => sweepCheckouts(log), CHECKOUT_SWEEP_MS, "review checkout sweep", log);
  await checkoutSweep?.tick();
  let closing: Promise<void> | null = null;
  const close = async (): Promise<void> => {
    await sweep.stop();
    await goneSweep?.stop();
    await releaseSweep?.stop();
    await checkoutSweep?.stop();
    await daemon.close();
    unbindCarry();
    host.close();
  };
  return { port: daemon.port, host, hub: daemon.hub, close: () => (closing ??= close()) };
}

/** Start, then run until SIGTERM, SIGINT or `stop` aborts, then close. Resolves after shutdown completes. */
export async function serveFactoryUntilSignal(options: FactoryServerOptions, stop?: AbortSignal): Promise<void> {
  const server = await startFactoryServer(options);
  const reason = await untilStopped(stop);
  (options.logger ?? consoleLogger).info({ signal: reason }, "shutting down");
  await server.close();
}

function untilStopped(stop?: AbortSignal): Promise<string> {
  return new Promise((resolve) => {
    const done = (reason: string): void => {
      process.off("SIGTERM", done);
      process.off("SIGINT", done);
      stop?.removeEventListener("abort", aborted);
      resolve(reason);
    };
    const aborted = (): void => done("abort");
    process.once("SIGTERM", done);
    process.once("SIGINT", done);
    if (stop?.aborted) return done("abort");
    stop?.addEventListener("abort", aborted, { once: true });
  });
}

const stateDirOf = (options: FactoryServerOptions): string => options.stateDir ?? dirname(options.dbPath);

function daemonOptions(host: FactoryHost, options: FactoryServerOptions, github: GithubHealth, build: BehindMain & { sha: string }): StartDaemonOptions<FactoryContext> {
  const { routeFor } = routedRunner(options.routes);
  return {
    registry: createFactoryRegistry(),
    createContext: () => factoryContext(host, options.routes),
    version: FACTORY_VERSION,
    stateDir: stateDirOf(options),
    port: options.port ?? FACTORY_PORT,
    host: options.hostname,
    toolPrefix: TOOL_PREFIX,
    mcpName: "titan-factory",
    health: () => ({
      ...factoryHealth(host, routeFor),
      github: github.status(),
      build: { sha: build.sha, behindMain: build.status() },
      lastDeploy: readLastDeploy(options.deployStateDir ?? factoryStateDir(process.env)),
    }),
    logger: options.logger,
  };
}

function buildHealth(options: FactoryServerOptions): BehindMain & { sha: string } {
  const sha = options.build?.sha ?? buildSha();
  const probe = options.build?.behindMain ?? behindMain({ sha });
  void probe.refresh();
  return { sha, status: probe.status, refresh: probe.refresh };
}

/** Without `routeFor`, `busy` cannot see park-routed steps and lists only review and merging steps. */
export function factoryHealth(host: FactoryHost, routeFor: RoutedRunner["routeFor"] = () => undefined): Record<string, unknown> {
  const runs = Object.fromEntries(STATUSES.map((status) => [status, 0])) as Record<WorkflowStatus, number>;
  for (const run of host.runtime.list([...STATUSES])) runs[run.status] += 1;
  return { runs, pendingGates: host.pendingGates().length, busy: busyRuns(host.runtime.list(["running"]), routeFor) };
}

interface Sweep {
  tick(): Promise<void>;
  stop(): Promise<void>;
}

/** Runs resync could not end are rechecked against their PR just before they are claimed, then dropped once claimed or settled. */
async function adopt(host: FactoryHost, services: ShepherdServices | undefined, held: Set<string>, log: Logger): Promise<void> {
  if (services) await recheckBeforeAdopt(host, services, held, log);
  const ids = await host.adopt();
  for (const id of ids) held.delete(id);
  if (ids.length > 0) log.info({ runs: ids }, "adopted runs");
}

async function recheckBeforeAdopt(host: FactoryHost, services: ShepherdServices, held: Set<string>, log: Logger): Promise<void> {
  for (const ended of await recheckHeld(host, services, held)) log.info({ ...ended }, "ended a held run whose PR left Shepherd before adoption");
}

async function endGone(host: FactoryHost, services: ShepherdServices, log: Logger): Promise<void> {
  for (const ended of await endRunsGoneElsewhere(host, services)) log.info({ ...ended }, "ended a run whose PR left Shepherd");
  for (const moved of await supersedeMovedGates(host, services)) log.info({ ...moved }, "superseded a head gate whose PR head moved");
}

/** Runs before the first adoption, so no run whose PR left Shepherd is driven again; a failure is logged and startup goes on. */
async function resync(host: FactoryHost, services: ShepherdServices, log: Logger, held: Set<string>): Promise<void> {
  try {
    const report = await resyncShepherd(host, services);
    for (const runId of report.held) held.add(runId);
    for (const ended of report.ended) log.info({ ...ended }, "resync ended a run whose PR left Shepherd");
    log.info({ ended: report.ended.length, orphanGates: report.orphanGates.length, superseded: report.superseded.length }, "shepherd resync at start");
  } catch (err) {
    log.error({ err }, "shepherd resync at start failed");
  }
}

async function sweepReleases(host: FactoryHost, services: ShepherdServices, log: Logger): Promise<void> {
  for (const note of await sweepVersionPackages(host, services)) log.info({ ...note }, "swept a Version Packages PR");
}

export async function sweepCheckouts(log: Logger, deps: ReviewCheckoutSweepDeps = {}): Promise<void> {
  const onError = (path: string, error: unknown): void =>
    log.warn({ path, err: error instanceof Error ? error.message : String(error) }, "review checkout sweep failed on an entry");
  for (const path of await sweepReviewCheckouts({ ...deps, onError })) log.info({ path }, "removed a stale review checkout");
}

/** One tick at a time, every `everyMs`; adoption picks up runs whose owning process exited without releasing. */
function startSweep(tickOnce: () => Promise<void>, everyMs: number, name: string, log: Logger): Sweep {
  let inFlight: Promise<void> | null = null;
  const tick = (): Promise<void> =>
    (inFlight ??= tickOnce()
      .catch((err: unknown) => log.error({ err }, `${name} failed`))
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
