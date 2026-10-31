import { createRequire } from "node:module";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { consoleLogger, daemonPaths, readPidFile, startDaemon, type DaemonHandle, type EventHub, type Logger, type StartDaemonOptions } from "@titan-design/daemon";
import { routedRunner } from "@titan-design/workflow";
import { behindMain, type BehindMain } from "./behind-main.js";
import { openServeBot, type BotHealth, type BotIdentity } from "./bot-identity.js";
import { buildSha } from "./build-info.js";
import { ownClosure } from "./checkout-closure.js";
import { factoryStateDir } from "./config.js";
import { startDeployPacer } from "./deploy-pacer-sweep.js";
import type { DeployWatch } from "./deploy-watch.js";
import { gateNotifyWatch, type GateNotifyOptions, type GateNotifyWatch } from "./gate-notify-sweep.js";
import { githubHealth, type GithubHealth } from "./github-health.js";
import type { GithubApiHealth } from "./github-api/status.js";
import { startUsageLog } from "./github-api/usage-meter.js";
import { createPassStamp, resolveSources, type PassStamp, type SourcesReader } from "./github-sources/mode.js";
import { restartDivergedLogged } from "./shepherd/diverged-sweep.js";
import type { DeployPacerOptions } from "./shepherd/deploy-pacer.js";
import { busyRuns } from "./restart-drain.js";
import { gateQueuedRun, heldRun } from "./serve-holds.js";
import { timestampConsole } from "./serve-log.js";
import { startUnlessLive, type HealthProbe } from "./serve-beside-live.js";
import { startLoopDelayWatch } from "./serve-loop-delay.js";
import { SHUTDOWN_SWEEP_GRACE_MS, closeServer } from "./serve-shutdown.js";
import { untilStopped } from "./serve-signal.js";
import { startDeployWatch, sweepFixers } from "./serve-sweeps.js";
import { logAgentChatCalls } from "./serve-agent-chat-timing.js";
import type { ServeReconciler } from "./reconciler/bot-ports.js";
import { startServeReconciler, type ReconcilerHealth } from "./serve-reconciler.js";
import { recordStartOrWarn, type ServeStart } from "./serve-starts.js";
import { serveHealth } from "./serve-health.js";
import { startServeIngress, type ServeIngressOptions } from "./serve-ingress.js";
import type { IngressListener, IngressStatus } from "./ingress/listen.js";
import type { FactoryHost, FactoryHostOptions } from "./host.js";
import type { NeedsSources } from "./needs/rpc.js";
import { loadOwnerKeys, type OwnerKeys } from "./owner-keys.js";
import { startStandingAnswerSweep } from "./owner-ops/standing-answers.js";
import { createFactoryRegistry, factoryContext, type FactoryContext } from "./registry.js";
import { mountServeRoutes, type ConsoleAnswersServeOptions } from "./serve-routes.js";
import { startSweep, type Sweep } from "./sweep.js";
import type { ShepherdServices } from "./shepherd/services.js";
import { openFramedHost, type FramedHostOptions } from "./shepherd/frames.js";
import { GONE_SWEEP_MS, endRunsGoneElsewhere } from "./shepherd/gone-elsewhere.js";
import type { ClearedMainGate } from "./shepherd/main-ci-cleared.js";
import { startHeadMovedSweep, type HeadMovedSweepOptions } from "./shepherd/head-moved-sweep.js";
import { startVisualDeliverySweep } from "./shepherd/visual-delivery-sweep.js";
import { startRoundShipSweep } from "./shepherd/round-ship-sweep.js";
import { recheckHeld, resyncShepherd, supersedeTransientGates } from "./shepherd/resync.js";
import { closeThawedMainGates } from "./shepherd/thawed-main-gates.js";
import { watchThaws } from "./shepherd/thaw-watch.js";
import { markRevertedRuns } from "./shepherd/reverts.js";
import { FIXER_RETIRE_MS, type FixerRetirePorts } from "./shepherd/fixer-retire.js";
import { MAIN_WATCH_MS, openMainWatch, type MainWatchPorts } from "./shepherd/main-watch.js";
import { SEAT_DIGEST_MS, fileSeatDigestMemory, sweepSeatDigests, type SeatDigestPorts } from "./shepherd/seat-digest.js";
import { digestPacer } from "./shepherd/seat-digest-pace.js";
import { bindCarryStateDir } from "./shepherd/tree-carry.js";
import { sweepReviewCheckouts, type ReviewCheckoutSweepDeps } from "./shepherd/review-checkout-sweep.js";
import { RELEASE_SWEEP_MS, TOOLCHAIN_SWEEP_MS, sweepReleases, sweepToolchains } from "./shepherd/package-sweeps.js";
import { readPath } from "./narrow.js";

export type { FactoryContext } from "./registry.js";
export { factoryHealth } from "./serve-health.js";

export const FACTORY_PORT = 7410;
/** Empty so registered commands keep their own names: `shepherd.register` becomes `shepherd__register`, not `factory__shepherd__register`. */
export const TOOL_PREFIX = "";
const DEFAULT_LEASE_MS = 30_000;
const IN_MEMORY_DB = ":memory:";
const CHECKOUT_SWEEP_MS = 3_600_000;
/** With no reader the reconciler runs as a polling deployment at the default interval, as the absent config block means. */
const DEFAULT_SOURCES: SourcesReader = () => resolveSources({});
const FACTORY_VERSION = String(readPath(createRequire(import.meta.url)("../package.json"), "version"));

export interface FactoryServerOptions extends FactoryHostOptions, HeadMovedSweepOptions, FramedHostOptions, ConsoleAnswersServeOptions {
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
  /** How often the toolchain adoption sweep runs; defaults to `TOOLCHAIN_SWEEP_MS`. */
  toolchainSweepMs?: number;
  /** Replaces the `gh api rate_limit` probe behind health's `github` field; tests stub it. */
  github?: GithubHealth;
  /** Behind health's `sources` field, the ingress kill switch and the reconciler's cadence; absent means no field and the polling defaults. */
  sources?: SourcesReader;
  /** Behind health's `githubApi` field: the bot pool's state per call class; absent means no field until the bot client binds it. */
  githubApi?: () => GithubApiHealth;
  /** The GitHub backstop, built over the bot's access alone; absent, `enabled` off, or a bot that cannot run it means serve starts no reconciler. */
  reconciler?: ServeReconciler;
  /** The webhook ingress listener beside the daemon, gated per request by `sources`; absent means serve binds no ingress port. */
  ingress?: ServeIngressOptions;
  /** Replaces the baked-in build sha behind health's `build` field; tests inject it. */
  build?: { sha: string; behindMain?: BehindMain };
  /** Where health's `lastDeploy` reads deploy.json and the console's deploy-pause-clear finds the pause; defaults to the XDG state dir the deployer writes. */
  deployStateDir?: string;
  /** Resync Shepherd's runs and gates with GitHub before the first adoption; defaults to true. */
  resyncOnStart?: boolean;
  /** Behind health's `deploy` block and the hub seat's deploy alarm; absent means neither. */
  deployWatch?: DeployWatch;
  /** Spawns the deployer for Shepherd's queued merge sha once merges go quiet; absent means no sweep and no `deployPending` in health. */
  deployPacer?: DeployPacerOptions;
  /** Where the main CI watch sends a red sha's one event; absent means main is watched only after a Shepherd run's own merge. */
  mainWatch?: MainWatchPorts;
  /** Reclaims a main-red fixer once its red main is over; absent means fixers stay until the owner retires them. */
  fixerRetire?: FixerRetirePorts;
  /** Where each seat's digest of open gates, told fix rounds and finished runs goes on a change; absent means serve sends none. */
  seatDigest?: SeatDigestPorts;
  /** Posts pending decision gates to agent-chat's human queue and resolves them from the answers; absent means serve asks nothing. */
  gateNotify?: GateNotifyOptions;
  /** The audience an owner proof must name; defaults to this machine's hostname. */
  aud?: string;
  /** Replaces the bot identity read from the code-fixed `BOT_TOKEN_PATH`; tests inject it. No flag or config reaches this. */
  bot?: () => BotIdentity;
  /** Replaces the live owner-queue adapters behind needs.list and needs.count; tests inject it. */
  needsSources?: NeedsSources;
  /** Replaces the /health probe that tells a live factory from a refused start; tests inject it. */
  probe?: HealthProbe;
  /** Replaces `SHUTDOWN_SWEEP_GRACE_MS`; tests shorten it. */
  shutdownGraceMs?: number;
}

interface OwnerProofs {
  keys: OwnerKeys;
  aud: string;
}

export interface FactoryServer {
  readonly port: number;
  readonly host: FactoryHost;
  readonly hub: EventHub;
  /** Halt the sweeps, release every lease, give running sweep ticks a bounded grace, then stop the daemon and close the database. Idempotent. */
  close(): Promise<void>;
}

/** Owns the factory database for as long as it runs, so runs outlive the shell that started them. */
export async function startFactoryServer(options: FactoryServerOptions): Promise<FactoryServer> {
  const stateDir = stateDirOf(options);
  const log = options.logger ?? consoleLogger;
  const bot = openServeBot(options.bot, log, stateDir);
  const { host, frames } = openFramedHost({ ...options, capabilities: { ...options.capabilities, ...bot.capabilities } });
  const github = options.github ?? githubHealth();
  void github.refresh();
  const build = buildHealth(options);
  const notify = options.gateNotify && gateNotifyWatch(host, options.gateNotify, log);
  const ingressRef: { listener?: IngressListener } = {};
  const reconcilerRef: { health: ReconcilerHealth } = { health: "disabled" };
  const passStamp = createPassStamp();
  const extras: ServeExtras = { notify, ingress: () => ingressRef.listener?.status(), passStamp, bot: bot.health, reconciler: () => reconcilerRef.health };
  const daemon = frames.started(await startCountedDaemon(host, options, github, build, log, extras));
  const ingress = (ingressRef.listener = await startServeIngress(host, options, log));
  const loopDelay = startLoopDelayWatch({ log });
  const unbindCarry = bindCarryStateDir(stateDir);
  const services = options.routes.shepherd;
  const held = new Set<string>();
  let closing: Promise<void> | null = null;
  const thaws = watchThaws(services);
  if (services && options.resyncOnStart !== false) await resync(host, services, log, held);
  const sweep = startSweep(() => adopt(host, services, held, log, () => closing !== null), options.leaseMs ?? DEFAULT_LEASE_MS, "adoption sweep", log);
  await sweep.tick();
  const goneSweep = services && startSweep(() => endGone(host, services, log, thaws.thawed), options.goneSweepMs ?? GONE_SWEEP_MS, "merged-elsewhere sweep", log);
  const fixerSweep = services?.freeze && options.fixerRetire && startSweep(() => sweepFixers(options.fixerRetire!, services.freeze!, log), FIXER_RETIRE_MS, "ended main-red fixer sweep", log);
  thaws.onThaw(() => [goneSweep, fixerSweep].forEach((swept) => void swept?.tick()));
  await goneSweep?.tick();
  const headMovedSweep = services && (await startHeadMovedSweep(host, services, options, log));
  const releaseSweep = services && startSweep(() => sweepReleases(host, services, log), options.releaseSweepMs ?? RELEASE_SWEEP_MS, "version packages sweep", log);
  const toolchainSweep = services && startSweep(() => sweepToolchains(host, services, log), options.toolchainSweepMs ?? TOOLCHAIN_SWEEP_MS, "toolchain adoption sweep", log);
  const checkoutSweep = services && startSweep(() => sweepCheckouts(log), CHECKOUT_SWEEP_MS, "review checkout sweep", log);
  await checkoutSweep?.tick();
  const deploySweep = startDeployWatch(options.deployWatch, log);
  const mainWatch = services && options.mainWatch && openMainWatch(services, options.mainWatch, stateDir, log);
  const mainSweep = mainWatch && startSweep(mainWatch.tick, MAIN_WATCH_MS, "main CI watch", log);
  void mainSweep?.tick();
  const digestSweep = startSeatDigest(host, services, options.seatDigest, stateDir, log);
  const busy = () => busyRuns(host.runtime.list(["running"]), routedRunner(options.routes).routeFor, heldRun(services), gateQueuedRun(services)).length;
  const pacerSweep = startDeployPacer(options.deployPacer, { now: options.now ?? Date.now, runningSha: build.sha, busy }, log);
  const notifySweep = notify?.start();
  const deliverySweep = startVisualDeliverySweep(host, services, log);
  const shipSweep = startRoundShipSweep(host, services, options.consoleAnswers?.roundsDir, log, options.now);
  const standingSweep = startStandingAnswerSweep(host, services, { actionsDir: options.consoleAnswers?.actionsDir, stateDir, now: options.now, tell: options.consoleAnswers?.tellOwner }, log);
  const reconciler = startServeReconciler(options.reconciler, bot.access(), { sources: options.sources ?? DEFAULT_SOURCES, db: host.db, log, now: options.now, stamp: passStamp });
  reconcilerRef.health = reconciler.health;
  const sweeps = [sweep, goneSweep, headMovedSweep, fixerSweep, releaseSweep, toolchainSweep, checkoutSweep, deploySweep, mainSweep];
  sweeps.push(digestSweep, pacerSweep, notifySweep, deliverySweep, shipSweep, standingSweep, reconciler.sweep);
  if (bot.usage) sweeps.push(...startUsageLog(bot.usage, "bot", log));
  const close = () => closeServer({ sweeps, watches: [thaws, frames, loopDelay], mainWatch, ingress, daemon, unbindCarry, host }, log, options.shutdownGraceMs ?? SHUTDOWN_SWEEP_GRACE_MS);
  return { port: daemon.port, host, hub: daemon.hub, close: () => (closing ??= close()) };
}

/** Start, then run until SIGTERM, SIGINT or `stop` aborts, then close. Resolves after shutdown completes. */
export async function serveFactoryUntilSignal(options: FactoryServerOptions, stop?: AbortSignal): Promise<void> {
  const restoreConsole = timestampConsole();
  const agentChatTiming = logAgentChatCalls({ log: options.logger ?? consoleLogger });
  try {
    const server = await startUnlessLive(() => startFactoryServer(options), options.logger ?? consoleLogger, options.probe);
    if (server === null) return;
    const reason = await untilStopped(stop);
    (options.logger ?? consoleLogger).info({ signal: reason }, "shutting down");
    await server.close();
  } finally {
    agentChatTiming.stop();
    restoreConsole();
  }
}

/** `dirname(":memory:")` is the working directory, so an in-memory database must name its state directory rather than leave the pid file and start record in the cwd. */
function stateDirOf(options: FactoryServerOptions): string {
  if (options.stateDir !== undefined) return options.stateDir;
  if (options.dbPath === IN_MEMORY_DB) throw new Error("titan-factory serve needs a stateDir when the database is in memory");
  return dirname(options.dbPath);
}

type BuildHealth = BehindMain & { sha: string };

/** The pid file is read before startDaemon removes a stale one: a leftover file means the last serve exited without cleaning up. A refused start is not counted. */
async function startCountedDaemon(host: FactoryHost, options: FactoryServerOptions, github: GithubHealth, build: BuildHealth, log: Logger, extras: ServeExtras): Promise<DaemonHandle> {
  const stateDir = stateDirOf(options);
  try {
    const unclean = (await readPidFile(daemonPaths(stateDir))) !== null;
    const recorded: { start?: ServeStart } = {};
    const daemon = await startDaemon(daemonOptions(host, options, github, build, { proofs: ownerProofs(options), start: () => recorded.start, ...extras }));
    recorded.start = recordStartOrWarn(stateDir, { unclean, now: new Date((options.now ?? Date.now)()) }, log);
    return daemon;
  } catch (err) {
    host.close();
    throw err;
  }
}

/** Keys are read once at start, so /health and the route always agree; installing or rotating a key means a restart. */
function ownerProofs(options: FactoryServerOptions): OwnerProofs {
  return { keys: loadOwnerKeys(), aud: options.aud ?? hostname() };
}

type ServeExtras = Pick<DaemonExtras, "notify" | "ingress" | "passStamp" | "bot" | "reconciler">;

interface DaemonExtras {
  proofs: OwnerProofs;
  start: () => ServeStart | undefined;
  notify: GateNotifyWatch | undefined;
  /** Started after the daemon, so a second serve beside a live one never binds the ingress port. */
  ingress: () => IngressStatus | undefined;
  passStamp: PassStamp;
  bot: () => BotHealth;
  /** Set once serve has decided on the reconciler, after the daemon is up. */
  reconciler: () => ReconcilerHealth;
}

function daemonOptions(host: FactoryHost, options: FactoryServerOptions, github: GithubHealth, build: BuildHealth, extras: DaemonExtras): StartDaemonOptions<FactoryContext> {
  const { proofs, start, notify, ingress, passStamp, bot, reconciler } = extras;
  const { routeFor } = routedRunner(options.routes);
  const log = options.logger ?? consoleLogger;
  const deployStateDir = options.deployStateDir ?? factoryStateDir(process.env);
  return {
    registry: createFactoryRegistry(log),
    createContext: () => factoryContext(host, options.routes, proofs.aud, options.needsSources),
    version: FACTORY_VERSION,
    stateDir: stateDirOf(options),
    port: options.port ?? FACTORY_PORT,
    host: options.hostname,
    toolPrefix: TOOL_PREFIX,
    mcpName: "titan-factory",
    health: () => serveHealth(host, options, { github, build, routeFor, ownerKeys: proofs.keys, start: start(), notify, ingress: ingress(), passStamp, bot: bot(), reconciler: reconciler() }),
    mountRoutes: (app) =>
      mountServeRoutes(app, { host, ...proofs, now: options.now ?? Date.now, routes: options.routes, consoleAnswers: options.consoleAnswers, stateDir: stateDirOf(options), deployStateDir, log }),
    logger: options.logger,
  };
}

function buildHealth(options: FactoryServerOptions): BuildHealth {
  const sha = options.build?.sha ?? buildSha();
  const probe = options.build?.behindMain ?? behindMain({ sha, closure: ownClosure });
  void probe.refresh();
  return { sha, status: probe.status, refresh: probe.refresh };
}

function startSeatDigest(host: FactoryHost, services: ShepherdServices | undefined, ports: SeatDigestPorts | undefined, stateDir: string, log: Logger): Sweep | undefined {
  if (services === undefined || ports === undefined) return undefined;
  const memory = fileSeatDigestMemory(stateDir);
  const pacer = ports.pacing && digestPacer(ports.pacing);
  const tickOnce = async (): Promise<void> => {
    const { sent, failed } = await sweepSeatDigests(host, services, ports, memory, new Date(), pacer);
    if (sent.length > 0) log.info({ seats: sent }, "sent seat digests");
    for (const failure of failed) log.warn({ ...failure }, "could not send a seat digest; the next sweep tries again");
  };
  return startSweep(tickOnce, SEAT_DIGEST_MS, "seat digest", log);
}

/** Runs resync could not end are rechecked against their PR just before they are claimed, then dropped once claimed or settled. A recheck still running when close starts claims nothing, because the runtime has already let its runs go. */
async function adopt(host: FactoryHost, services: ShepherdServices | undefined, held: Set<string>, log: Logger, closing: () => boolean): Promise<void> {
  if (services) await restartDivergedLogged(host, services, log, closing);
  const exclude = services ? await recheckBeforeAdopt(host, services, held, log) : new Set<string>();
  if (closing()) return;
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
  const onMainGreen = (cleared: ClearedMainGate) => log.info({ ...cleared }, "cleared a main-ci-timeout gate on a green main containing the merge");
  for (const ended of await endRunsGoneElsewhere(host, services, { onCancelFailed, onMainGreen })) log.info({ ...ended }, "ended a run whose PR left Shepherd");
  for (const closed of closeThawedMainGates(host, services)) log.info({ ...closed }, "cancelled a main gate whose freeze episode had thawed");
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

/** Runs before the first adoption, so no run whose PR left Shepherd is driven again; a failure is logged and startup goes on. */
async function resync(host: FactoryHost, services: ShepherdServices, log: Logger, held: Set<string>): Promise<void> {
  try {
    const report = await resyncShepherd(host, services);
    for (const runId of report.held) held.add(runId);
    for (const ended of report.ended) log.info({ ...ended }, "resync ended a run whose PR left Shepherd");
    for (const failed of report.cancelErrors) log.warn({ ...failed }, "resync could not cancel a run whose PR left Shepherd");
    if (report.supersedeError) log.error({ err: report.supersedeError }, "shepherd resync could not supersede moved gates");
    log.info({ ended: report.ended.length, orphanGates: report.orphanGates.length, superseded: report.superseded.length, phaseMs: report.phaseMs }, "shepherd resync at start");
  } catch (err) {
    log.error({ err }, "shepherd resync at start failed");
  }
}

export async function sweepCheckouts(log: Logger, deps: ReviewCheckoutSweepDeps = {}): Promise<void> {
  const onError = (path: string, error: unknown): void =>
    log.warn({ path, err: error instanceof Error ? error.message : String(error) }, "review checkout sweep failed on an entry");
  for (const path of await sweepReviewCheckouts({ ...deps, onError })) log.info({ path }, "removed a stale review checkout");
}
