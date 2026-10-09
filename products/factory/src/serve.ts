import { createRequire } from "node:module";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { consoleLogger, daemonPaths, readPidFile, startDaemon, type DaemonHandle, type EventHub, type Logger, type StartDaemonOptions } from "@titan-design/daemon";
import { routedRunner, type RoutedRunner, type WorkflowStatus } from "@titan-design/workflow";
import { behindMain, type BehindMain } from "./behind-main.js";
import { buildSha } from "./build-info.js";
import { factoryStateDir } from "./config.js";
import { readLastDeploy } from "./deploy-ports.js";
import { DEPLOY_WATCH_MS, type DeployWatch } from "./deploy-watch.js";
import { githubHealth, type GithubHealth } from "./github-health.js";
import { busyRuns, heldSkipped, type HoldPredicate } from "./restart-drain.js";
import { timestampConsole } from "./serve-log.js";
import { recordServeStart, serveStartsHealth, type ServeStart } from "./serve-starts.js";
import { openFactoryHost, type FactoryHost, type FactoryHostOptions } from "./host.js";
import type { NeedsSources } from "./needs/rpc.js";
import { loadOwnerKeys, type OwnerKeys } from "./owner-keys.js";
import { createFactoryRegistry, factoryContext, type FactoryContext } from "./registry.js";
import { mountResolveProof } from "./resolve-proof.js";
import type { ShepherdServices } from "./shepherd/commands.js";
import { GONE_SWEEP_MS, endRunsGoneElsewhere } from "./shepherd/gone-elsewhere.js";
import { supersedeMovedGates } from "./shepherd/head-moved.js";
import { recheckHeld, resyncShepherd, supersedeTransientGates } from "./shepherd/resync.js";
import { markRevertedRuns } from "./shepherd/reverts.js";
import { bindCarryStateDir } from "./shepherd/tree-carry.js";
import { sweepReviewCheckouts, type ReviewCheckoutSweepDeps } from "./shepherd/review-checkout-sweep.js";
import { RELEASE_SWEEP_MS, sweepVersionPackages } from "./shepherd/version-packages.js";

export type { FactoryContext } from "./registry.js";

export const FACTORY_PORT = 7410;
/** Empty so registered commands keep their own names: `shepherd.register` becomes `shepherd__register`, not `factory__shepherd__register`. */
export const TOOL_PREFIX = "";
const DEFAULT_LEASE_MS = 30_000;
const IN_MEMORY_DB = ":memory:";
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
  /** Behind health's `deploy` block and the hub seat's deploy alarm; absent means neither. */
  deployWatch?: DeployWatch;
  /** The audience an owner proof must name; defaults to this machine's hostname. */
  aud?: string;
  /** Replaces the root-owned key directory read at start; tests inject it. No flag or config reaches this. */
  ownerKeys?: () => OwnerKeys;
  /** Replaces the live owner-queue adapters behind needs.list and needs.count; tests inject it. */
  needsSources?: NeedsSources;
}

interface OwnerProofs {
  keys: OwnerKeys;
  aud: string;
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
  const stateDir = stateDirOf(options);
  const host = openFactoryHost(options);
  const github = options.github ?? githubHealth();
  void github.refresh();
  const build = buildHealth(options);
  const log = options.logger ?? consoleLogger;
  const daemon = await startCountedDaemon(host, options, github, build, log);
  const unbindCarry = bindCarryStateDir(stateDir);
  const services = options.routes.shepherd;
  const held = new Set<string>();
  const thaws = watchThaws(services);
  if (services && options.resyncOnStart !== false) await resync(host, services, log, held);
  const sweep = startSweep(() => adopt(host, services, held, log), options.leaseMs ?? DEFAULT_LEASE_MS, "adoption sweep", log);
  await sweep.tick();
  const goneSweep = services && startSweep(() => endGone(host, services, log, thaws.thawed), options.goneSweepMs ?? GONE_SWEEP_MS, "merged-elsewhere and head-moved sweep", log);
  thaws.onThaw(() => void goneSweep?.tick());
  await goneSweep?.tick();
  const releaseSweep = services && startSweep(() => sweepReleases(host, services, log), options.releaseSweepMs ?? RELEASE_SWEEP_MS, "version packages sweep", log);
  const checkoutSweep = services && startSweep(() => sweepCheckouts(log), CHECKOUT_SWEEP_MS, "review checkout sweep", log);
  await checkoutSweep?.tick();
  const deploySweep = startDeployWatch(options.deployWatch, log);
  let closing: Promise<void> | null = null;
  const close = async (): Promise<void> => {
    await sweep.stop();
    thaws.stop();
    for (const later of [goneSweep, releaseSweep, checkoutSweep, deploySweep]) await later?.stop();
    await daemon.close();
    unbindCarry();
    host.close();
  };
  return { port: daemon.port, host, hub: daemon.hub, close: () => (closing ??= close()) };
}

/** Start, then run until SIGTERM, SIGINT or `stop` aborts, then close. Resolves after shutdown completes. */
export async function serveFactoryUntilSignal(options: FactoryServerOptions, stop?: AbortSignal): Promise<void> {
  const restoreConsole = timestampConsole();
  try {
    const server = await startFactoryServer(options);
    const reason = await untilStopped(stop);
    (options.logger ?? consoleLogger).info({ signal: reason }, "shutting down");
    await server.close();
  } finally {
    restoreConsole();
  }
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

/** `dirname(":memory:")` is the working directory, so an in-memory database must name its state directory rather than leave the pid file and start record in the cwd. */
function stateDirOf(options: FactoryServerOptions): string {
  if (options.stateDir !== undefined) return options.stateDir;
  if (options.dbPath === IN_MEMORY_DB) throw new Error("titan-factory serve needs a stateDir when the database is in memory");
  return dirname(options.dbPath);
}

type BuildHealth = BehindMain & { sha: string };

/** The pid file is read before startDaemon removes a stale one: a leftover file means the last serve exited without cleaning up. A refused start is not counted. */
async function startCountedDaemon(host: FactoryHost, options: FactoryServerOptions, github: GithubHealth, build: BuildHealth, log: Logger): Promise<DaemonHandle> {
  const stateDir = stateDirOf(options);
  try {
    const unclean = (await readPidFile(daemonPaths(stateDir))) !== null;
    const recorded: { start?: ServeStart } = {};
    const daemon = await startDaemon(daemonOptions(host, options, github, build, { proofs: ownerProofs(options), start: () => recorded.start }));
    recorded.start = recordStart(stateDir, unclean, options, log);
    return daemon;
  } catch (err) {
    host.close();
    throw err;
  }
}

/** A start record that cannot be written costs /health its start fields, never the start itself. */
function recordStart(stateDir: string, unclean: boolean, options: FactoryServerOptions, log: Logger): ServeStart | undefined {
  try {
    return recordServeStart(stateDir, { unclean, now: new Date((options.now ?? Date.now)()) });
  } catch (err) {
    log.warn({ err }, "could not record the serve start");
    return undefined;
  }
}

/** Keys are read once at start, so /health and the route always agree; installing or rotating a key means a restart. */
function ownerProofs(options: FactoryServerOptions): OwnerProofs {
  return { keys: (options.ownerKeys ?? loadOwnerKeys)(), aud: options.aud ?? hostname() };
}

interface DaemonExtras {
  proofs: OwnerProofs;
  start: () => ServeStart | undefined;
}

function daemonOptions(host: FactoryHost, options: FactoryServerOptions, github: GithubHealth, build: BuildHealth, { proofs, start }: DaemonExtras): StartDaemonOptions<FactoryContext> {
  const { routeFor } = routedRunner(options.routes);
  const log = options.logger ?? consoleLogger;
  return {
    registry: createFactoryRegistry(log),
    createContext: () => factoryContext(host, options.routes, proofs.aud, options.needsSources),
    version: FACTORY_VERSION,
    stateDir: stateDirOf(options),
    port: options.port ?? FACTORY_PORT,
    host: options.hostname,
    toolPrefix: TOOL_PREFIX,
    mcpName: "titan-factory",
    health: () => ({
      ...factoryHealth(host, routeFor, heldRun(options.routes.shepherd)),
      github: github.status(),
      ...(options.routes.shepherd?.pacing && { snapshotTick: options.routes.shepherd.pacing.status() }),
      build: { sha: build.sha, behindMain: build.status() },
      lastDeploy: readLastDeploy(options.deployStateDir ?? factoryStateDir(process.env)),
      ...(options.deployWatch && { deploy: options.deployWatch.status() }),
      ownerKeys: proofs.keys.ok ? { count: proofs.keys.ids.length, ids: proofs.keys.ids } : { count: 0, refusal: proofs.keys.refusal },
      ...startHealth(start(), options),
    }),
    mountRoutes: (app) => mountResolveProof(app, { host, ...proofs, now: options.now ?? Date.now, port: options.routes.shepherd?.port, log }),
    logger: options.logger,
  };
}

const startHealth = (start: ServeStart | undefined, options: FactoryServerOptions): Record<string, unknown> =>
  start ? { ...serveStartsHealth(start, new Date((options.now ?? Date.now)())) } : {};

function buildHealth(options: FactoryServerOptions): BuildHealth {
  const sha = options.build?.sha ?? buildSha();
  const probe = options.build?.behindMain ?? behindMain({ sha });
  void probe.refresh();
  return { sha, status: probe.status, refresh: probe.refresh };
}

/** Without `routeFor`, `busy` cannot see park-routed steps and lists only review and merging steps. */
export function factoryHealth(host: FactoryHost, routeFor: RoutedRunner["routeFor"] = () => undefined, isHeld?: HoldPredicate): Record<string, unknown> {
  const runs = Object.fromEntries(STATUSES.map((status) => [status, 0])) as Record<WorkflowStatus, number>;
  for (const run of host.runtime.list([...STATUSES])) runs[run.status] += 1;
  const running = host.runtime.list(["running"]);
  const held = isHeld ? heldSkipped(running, routeFor, isHeld) : [];
  return { runs, pendingGates: host.pendingGates().length, busy: busyRuns(running, routeFor, isHeld), heldSkipped: held };
}

/** A run held and not yet satisfied cannot merge until release; a satisfied one may merge at any moment, and an unreadable store throws, which counts it busy. */
function heldRun(services: ShepherdServices | undefined): HoldPredicate | undefined {
  return services && ((run) => {
    const registration = services.store.get().byRun(run.id);
    return registration !== undefined && registration.held && registration.holdSatisfied === null;
  });
}

interface Sweep {
  tick(): Promise<void>;
  stop(): Promise<void>;
}

/** Runs resync could not end are rechecked against their PR just before they are claimed, then dropped once claimed or settled. */
async function adopt(host: FactoryHost, services: ShepherdServices | undefined, held: Set<string>, log: Logger): Promise<void> {
  const exclude = services ? await recheckBeforeAdopt(host, services, held, log) : new Set<string>();
  const ids = await host.adopt({ exclude });
  for (const id of ids) held.delete(id);
  if (ids.length > 0) log.info({ runs: ids }, "adopted runs");
}

/** The held runs whose PR could not be read, or whose cancel failed, are returned, so adoption leaves them for the next tick instead of failing open. */
async function recheckBeforeAdopt(host: FactoryHost, services: ShepherdServices, held: Set<string>, log: Logger): Promise<Set<string>> {
  const { ended, unreadable, uncancelled } = await recheckHeld(host, services, held);
  for (const run of ended) log.info({ ...run }, "ended a held run whose PR left Shepherd before adoption");
  for (const [runId, cause] of unreadable) log.warn({ runId, cause }, "left a held run unadopted: its PR could not be read");
  for (const [runId, cause] of uncancelled) log.warn({ runId, cause }, "left a held run unadopted: its PR left Shepherd but cancelling it failed");
  return new Set([...unreadable.keys(), ...uncancelled.keys()]);
}

async function endGone(host: FactoryHost, services: ShepherdServices, log: Logger, thawed: Set<string>): Promise<void> {
  const onCancelFailed = (runId: string, cause: string) => log.warn({ runId, cause }, "could not cancel a run whose PR left Shepherd");
  for (const ended of await endRunsGoneElsewhere(host, services, { onCancelFailed })) log.info({ ...ended }, "ended a run whose PR left Shepherd");
  for (const moved of await supersedeMovedGates(host, services)) log.info({ ...moved }, "superseded a head gate whose PR head moved");
  for (const repo of [...thawed]) await sweepThawed(host, services, log, thawed, repo);
}

/** Dequeued before the sweep, so a thaw that lands during it queues the repo again; a PR head that cannot be read, or a sweep that throws, requeues it for the next tick. */
async function sweepThawed(host: FactoryHost, services: ShepherdServices, log: Logger, thawed: Set<string>, repo: string): Promise<void> {
  thawed.delete(repo);
  const onUnreadable = (runId: string) => {
    thawed.add(repo);
    log.warn({ runId, repo }, "could not read the PR head of a thawed repo's gate; the next sweep tries again");
  };
  try {
    for (const gate of await supersedeTransientGates(host, services, { repo, onUnreadable })) log.info({ ...gate, repo }, "superseded an approve-merge gate a freeze caused once the repo thawed");
  } catch (err) {
    thawed.add(repo);
    throw err;
  }
  const reverts = await markRevertedRuns(host, services);
  for (const reverted of reverts.reverted) log.info({ ...reverted }, "marked a merged run reverted");
  for (const failed of reverts.errors) log.warn({ ...failed }, "could not read main for reverts");
}

interface ThawWatch {
  /** Repos thawed since the sweep last read them. */
  thawed: Set<string>;
  /** Runs `start` on each later thaw, outside the thaw's own call, so a gate the freeze caused is not left waiting out the sweep interval. */
  onThaw(start: () => void): void;
  stop(): void;
}

/** Watches from before resync and the first adoption, so a thaw any run causes then is still swept. */
function watchThaws(services: ShepherdServices | undefined): ThawWatch {
  const thawed = new Set<string>();
  let start = (): void => undefined;
  const stop = services?.freeze?.onThaw((repo) => {
    thawed.add(repo);
    queueMicrotask(() => start());
  });
  return { thawed, onThaw: (next) => void (start = next), stop: () => stop?.() };
}

/** Runs before the first adoption, so no run whose PR left Shepherd is driven again; a failure is logged and startup goes on. */
async function resync(host: FactoryHost, services: ShepherdServices, log: Logger, held: Set<string>): Promise<void> {
  try {
    const report = await resyncShepherd(host, services);
    for (const runId of report.held) held.add(runId);
    for (const ended of report.ended) log.info({ ...ended }, "resync ended a run whose PR left Shepherd");
    for (const failed of report.cancelErrors) log.warn({ ...failed }, "resync could not cancel a run whose PR left Shepherd");
    if (report.supersedeError) log.error({ err: report.supersedeError }, "shepherd resync could not supersede moved gates");
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

/** The first tick is not awaited: its redeploy.log read and index.lock probe (lsof, pgrep) must not hold up the start. */
function startDeployWatch(watch: DeployWatch | undefined, log: Logger): Sweep | undefined {
  const sweep = watch && startSweep(watch.tick, DEPLOY_WATCH_MS, "deploy watch", log);
  void sweep?.tick();
  return sweep;
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
