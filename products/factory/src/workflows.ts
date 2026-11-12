import { githubPort, octokitWire, sharedOctokit } from "@titan-design/github";
import type { ReviewTarget } from "@titan-design/review-panel";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { measurementAuditWorkflow } from "./audit/workflow.js";
import { deployCheckoutAncestry } from "./build-ancestry.js";
import { deployCheckoutFor } from "./cli-service.js";
import { configPath, factoryStateDir, loadConfig, readConfig, type FactoryConfig, type ShepherdRepoConfig } from "./config.js";
import { configRef, liveField, type ConfigRef } from "./config-ref.js";
import { configuredMainWatch } from "./main-watch-ports.js";
import { configuredMergeWake } from "./merge-wake.js";
import { holdAdversary, liveSpawnLimits, reviewAccounts, visualThresholdOf, visualTierOf, withHoldAdversary } from "./workflows-live.js";
import type { WorkflowDefinition } from "./definition.js";
import type { FactoryRoutes } from "./host.js";
import { hostCarryPorts } from "./shepherd/carry-cache-adapter.js";
import { reviewCheckPort } from "./shepherd/publish-review-adapter.js";
import { activeWorkFixTasks, activeWorkFollowUpTasks, activeWorkOrigin, activeWorkTasks, agentChatCleanupAgents } from "./shepherd/cleanup-ports.js";
import { ghGateway, type GhCallLine } from "./shepherd/gh-gateway.js";
import { freezeStoreRef, isFixersPr, type FreezeStoreRef } from "./shepherd/freeze.js";
import { agentChatAgents, installedHeadless } from "./shepherd/agents.js";
import { configuredExitNotice } from "./shepherd/exit-notice.js";
import { readShepherdLimits } from "./shepherd/limits-read.js";
import { machineStopWatch, type MachineStopWatch } from "./shepherd/machine-stop.js";
import { readMachine, spawnGate } from "./shepherd/spawn-gate.js";
import type { SpawnLimits } from "./shepherd/spawn-limits.js";
import { movedPastOnList, openHeadOnPort } from "./shepherd/review-queue.js";
import { reviewCheckoutRoot } from "./shepherd/review-checkout.js";
import { reviewCheckoutDisk } from "./shepherd/review-checkout-disk.js";
import { workflowModeOf } from "./shepherd/review-shadow.js";
import { fixersOver } from "./shepherd/main-red.js";
import { factoryShepherdWorkflow } from "./shepherd-phases.js";
import { nodeWantedStore } from "./shepherd/deploy-pacer.js";
import { systemDeployer } from "./shepherd/redeploy.js";
import { hostDeployerOptions, nodeDeployerPorts } from "./shepherd/redeploy-adapter.js";
import { codewatchReader, ghCodewatchReport } from "./shepherd/codewatch-questions.js";
import { cacheHeadLines } from "./shepherd/head-lines.js";
import { deploySkew } from "./shepherd/attest-skew.js";
import { activeWorkTaskTags, judgeOldPath } from "./old-path/task-tags.js";
import { agentChatReviewerDispatch } from "./shepherd/reviewer-dispatch.js";
import { configuredRoles } from "./shepherd/reviewer-roles.js";
import { agentChatRoster } from "./shepherd/roster.js";
import { transcriptReviewerReader } from "./shepherd/reviewer-reader.js";
import { boundCheckout, loadSeatBook, lookupSeat, type SeatBook } from "./shepherd/seats.js";
import { stickyAdvisory, type AdvisoryRead } from "./shepherd/advisory.js";
import { advisoryFile } from "./shepherd/advisory-file.js";
import { configuredStackRestack } from "./shepherd/stack-land.js";
import { configuredStatusContexts, withStatusChecks } from "./shepherd/status-checks.js";
import { shepherdStoreRef, type ShepherdStoreRef } from "./shepherd/store.js";
import { landPrWorkflow } from "./workflows/land-pr.js";
import { withAutoresearch } from "./autoresearch/configured.js";
import { chorePruning } from "./workflows/chore-prune.js";
import { hostPostMerge } from "./workflows/post-merge-adapter.js";
import { systemChorePorts } from "./workflows/post-merge-chore.js";
import { devicePrWorkflow } from "./workflows/device-pr.js";
import { buildSurfaceWorkflow } from "./build-surface/index.js";
import { tickPacing } from "./tick-pacing.js";
import { prSnapshot } from "./workflows/pr-snapshot.js";
import { pushSignal } from "./shepherd/push-signal.js";
import { localBasementSuite, suiteRules } from "./shepherd/suite-host.js";
import { configuredVisualDelivery } from "./shepherd/visual-delivery-sweep.js";
import { configuredDiagnosis, configuredReplan, configuredVisualPacket } from "./workflows-spawned.js";
import type { CleanupPorts, RosterReader, SpawnGate } from "./shepherd/ports.js";
import type { FactoryRouteDeps } from "./workflows-deps.js";
import { factoryRoutesFor } from "./workflows-routes.js";
export { factoryRoutesFor, bindAll, SHEPHERD_MIGRATIONS } from "./workflows-routes.js";
export type { FactoryRouteDeps } from "./workflows-deps.js";

/** Every workflow the CLI hosts. Pilots register here as their slices land (doc-change in S3). */
export const factoryWorkflows: readonly WorkflowDefinition[] = [landPrWorkflow(), factoryShepherdWorkflow(), measurementAuditWorkflow(), devicePrWorkflow(), buildSurfaceWorkflow()];

/** `shepherd.repos` as the config file writes it, re-read per call as the seat book is. */
type UnseatedRepos = () => Record<string, ShepherdRepoConfig>;

/** The PR registered as its frozen repo's fix; a store the host has not bound reads as no fixer, so the review queues like any other. */
function fixerReview(freeze: FreezeStoreRef, store: ShepherdStoreRef) {
  return ({ repo, pr }: ReviewTarget): boolean => {
    try {
      const red = freeze.get().get(repo);
      return red !== undefined && isFixersPr(red, store.get().byPr(repo, pr));
    } catch {
      return false;
    }
  };
}

/** Tells every seat that owns `repo` over agent-chat; a repo no seat owns has nobody to tell, which throws so the alert is tried again. */
function seatAlert(agentChatBin: string, seats: () => SeatBook, roster: RosterReader | undefined) {
  const agents = agentChatAgents(agentChatBin, { roster });
  return async (repo: string, text: string): Promise<void> => {
    const found = lookupSeat(seats(), repo);
    if (found.kind !== "seat") throw new Error(`no seat owns ${repo}`);
    for (const name of found.seat.name.split("+")) await agents.message(name, text);
  };
}

/** One dispatch serves both halves, so the reader finds the reviewer on the roster that started it. No `review` key starts nothing. */
function configuredReview(shepherd: FactoryConfig["shepherd"], config: ConfigRef, seats: () => SeatBook, repos: UnseatedRepos, roster: RosterReader | undefined, gate: SpawnGate, isFixer: (target: ReviewTarget) => boolean, machineStop: MachineStopWatch, env: NodeJS.ProcessEnv): FactoryRouteDeps["review"] {
  const { agentChatBin, review } = shepherd ?? {};
  if (!review || !agentChatBin) return undefined;
  const under = (configDir: string | undefined, fallbackConfigDirs?: () => readonly string[]) => agentChatReviewerDispatch({ agentChatBin, roles: configuredRoles(review), configDir, fallbackConfigDirs, cwdFor: (repo) => boundCheckout(seats(), repo, repos()), roster, gate, isFixer, onMachineHold: machineStop.note });
  const { primary: dispatch, accounts } = reviewAccounts(review, liveField(config, "shepherd.review.fallbackConfigDirs"), under, seatAlert(agentChatBin, seats, roster));
  const codewatch = review.codewatchRepos && codewatchReader(ghCodewatchReport(), review.codewatchRepos, cacheHeadLines({ ports: hostCarryPorts }));
  const wiring = { dispatch, lineage: dispatch.lineage, accounts, reader: transcriptReviewerReader({ roster: dispatch.roster }), timeoutMs: review.verdictTimeoutMs, sessionStartTimeoutMs: review.sessionStartTimeoutMs, reviewAppId: shepherd?.reviewCheck?.appId, roles: configuredRoles(review), machineStop, profileInstalled: (profile: string) => installedHeadless(profile), visualThreshold: visualThresholdOf(config), visualTier: visualTierOf(config), deploySkew: deploySkew(), oldPath: judgeOldPath({ tags: activeWorkTaskTags({ origin: activeWorkOrigin(env) }) }), followUps: activeWorkFollowUpTasks({ origin: activeWorkOrigin(env) }), ...(codewatch && { codewatch }), ...(review.panel && { panel: review.panel }), ...(review.scopedRereview && { scopedRereview: review.scopedRereview }), ...(review.scopeCheck && { scopeCheck: review.scopeCheck }), ...workflowModeOf(review.workflow) };
  return withHoldAdversary(wiring, holdAdversary(review, config, under, wiring.profileInstalled));
}

/** Cleanup retires agents through the configured `agent-chat`, so no binary configured means no retire and no task close. */
function configuredCleanup(shepherd: FactoryConfig["shepherd"], env: NodeJS.ProcessEnv, roster: RosterReader | undefined): CleanupPorts | undefined {
  const agentChatBin = shepherd?.agentChatBin;
  if (!agentChatBin) return undefined;
  return { agents: agentChatCleanupAgents(agentChatBin, undefined, undefined, roster), tasks: activeWorkTasks({ origin: activeWorkOrigin(env) }) };
}

/** Fix tasks go over active-work's loopback rpc; a fixer needs the configured `agent-chat`, and each spawn names the account the successor rotation picks. */
function configuredMainRed(shepherd: FactoryConfig["shepherd"], env: NodeJS.ProcessEnv, roster: RosterReader | undefined, gate: SpawnGate): FactoryRouteDeps["mainRed"] {
  const agentChatBin = shepherd?.agentChatBin;
  return { tasks: activeWorkFixTasks({ origin: activeWorkOrigin(env) }), ...(agentChatBin && { fixers: fixersOver(agentChatAgents(agentChatBin, { roster, gate })) }) };
}

function lowerKeys<V>(record: Record<string, V> | undefined): Record<string, V> | undefined {
  return record && Object.fromEntries(Object.entries(record).map(([key, value]) => [key.toLowerCase(), value]));
}

/** The `spawnGate` overrides plus the review floors and cap from `shepherd.review`; a key left out keeps its default. */
export function configuredSpawnLimits(shepherd: FactoryConfig["shepherd"]): Partial<SpawnLimits> {
  const review = shepherd?.review;
  const fromReview = { reviewMinFreeBytes: review?.minFreeBytes, reviewMinFreeInodesPct: review?.minFreeInodesPct, maxConcurrentReviews: review?.maxConcurrent };
  return { ...shepherd?.spawnGate, ...Object.fromEntries(Object.entries(fromReview).filter(([, value]) => value !== undefined)) };
}

/** The limits the production spawn gate reads: the startup factory values, the live factory rows, then the host's `limits.shepherd`, each read afresh. */
export function gateLimits(config: ConfigRef, env: NodeJS.ProcessEnv): () => Partial<SpawnLimits> {
  return liveSpawnLimits(configuredSpawnLimits(config.get().shepherd), config, () => readShepherdLimits(env));
}

/** The bin this bundle was built as: dist/bin.js sits beside the bundled routes. */
const ownBin = (): string => fileURLToPath(new URL("./bin.js", import.meta.url));
/** The post-merge chore wrapper, built beside bin.js as its own entry. */
const ownChoreMain = (): string => fileURLToPath(new URL("./chore-main.js", import.meta.url));

/**
 * The production route set: the post-merge chore and the reviewer come from the config file; the seat book is re-read per
 * registration and per spawn. Every port over the configured `agent-chat` shares one roster reader, so concurrent runs
 * start at most one `agent ls` per TTL window.
 */
export function configuredRoutes(env: NodeJS.ProcessEnv, overrides: Partial<FactoryRouteDeps> = {}): FactoryRoutes {
  const config = configRef(configPath(env), overrides.now);
  const { postMerge, shepherd, digest } = config.get();
  const seats = overrides.seats ?? ((): SeatBook => loadSeatBook(loadConfig(configPath(env)).shepherd ?? {}));
  const repos: UnseatedRepos = () => loadConfig(configPath(env)).shepherd?.repos ?? {};
  const agentChatBin = shepherd?.agentChatBin;
  const roster = overrides.roster ?? (agentChatBin ? agentChatRoster(agentChatBin, { now: overrides.now }) : undefined);
  const limits = gateLimits(config, env);
  const machineStop = overrides.machineStop ?? machineStopWatch({ read: () => readMachine(), limits });
  const client = sharedOctokit();
  const port = withStatusChecks(overrides.port ?? githubPort(octokitWire({ client })), configuredStatusContexts(() => config.get().shepherd?.repos));
  const pacing = tickPacing({ now: overrides.now });
  const snapshot = prSnapshot(port, { now: overrides.now, tickMs: pacing.tickMs });
  const movedPast = movedPastOnList((repo) => snapshot.cachedOpen?.(repo));
  const gate = overrides.spawnGate ?? spawnGate({ limits, disk: reviewCheckoutDisk(reviewCheckoutRoot()), onStop: machineStop.note, movedPast, liveHead: openHeadOnPort(port) });
  const store = overrides.store ?? shepherdStoreRef();
  const freeze = overrides.freeze ?? freezeStoreRef(overrides.now);
  const review = configuredReview(shepherd, config, seats, repos, roster, gate, fixerReview(freeze, store), machineStop, env);
  const cleanup = configuredCleanup(shepherd, env, roster);
  const mainRed = configuredMainRed(shepherd, env, roster, gate);
  const exitNotice = agentChatBin ? configuredExitNotice(seats, agentChatAgents(agentChatBin, { roster }), { hubSeat: shepherd.hubSeat, redSeat: shepherd.redSeat }, store) : undefined;
  const deployerOptions = { ...hostDeployerOptions(), bin: ownBin(), stateDir: factoryStateDir(env), isAncestor: deployCheckoutAncestry(deployCheckoutFor(env)) };
  const redeploy = systemDeployer(deployerOptions, nodeDeployerPorts, nodeWantedStore);
  const gateway = ghGateway({ client, snapshot, onCall: logGhCall });
  const pushes = pushSignal((repo) => boundCheckout(seats(), repo, repos()));
  const cwdFor = (repo: string) => boundCheckout(seats(), repo, repos());
  const chores = systemChorePorts({ dir: join(factoryStateDir(env), "chores"), wrapper: [process.execPath, ownChoreMain()] });
  const routes = factoryRoutesFor({ ...hostPostMerge(), port, snapshot, pushes, pacing, gateway, store, freeze, postMerge, chores, review, agentChatBin, agentChatConfigDir: shepherd?.fixer?.configDir, roster, spawnGate: gate, cleanup, mainRed, redeploy, exitNotice, flakyChecks: lowerKeys(shepherd?.flakyChecks), reviewCheck: reviewCheckPort(shepherd?.reviewCheck), suiteRules: suiteRules(localBasementSuite(env)), advisory: stickyAdvisory(configuredAdvisory(env), advisoryFile(factoryStateDir(env))), stackRestack: configuredStackRestack(() => readConfig(configPath(env))?.shepherd?.repos), heldRepair: liveField(config, "shepherd.gateReset.heldRepair"), noReproProceed: liveField(config, "shepherd.gateReset.noReproProceed"), nonSourceNoRepro: liveField(config, "shepherd.gateReset.nonSourceNoRepro"), taskClose: liveField(config, "shepherd.taskClose"), visualGate: liveField(config, "shepherd.visualGate"), visualPacket: configuredVisualPacket(shepherd, env, roster, gate, cwdFor), diagnosis: configuredDiagnosis(shepherd, env, roster, gate, cwdFor), replan: configuredReplan(shepherd, roster, gate, cwdFor), visualDelivery: configuredVisualDelivery(shepherd, env, roster, cwdFor, digest?.push), consoleAnswers: shepherd?.consoleAnswers !== undefined, thawAlert: configuredMainWatch(env), visualThreshold: visualThresholdOf(config), mergeWake: configuredMergeWake(shepherd?.mergeWake), ...overrides, seats });
  return withAutoresearch(Object.assign(routes, { config, ...chorePruning(chores) }), config.get().autoresearch);
}

function logGhCall(line: GhCallLine): void {
  console.warn(`shepherd: gh-call ${JSON.stringify(line)}`);
}

/** Each read takes the file afresh; no file reads as undefined, never as a map with no advisory repo in it. */
function configuredAdvisory(env: NodeJS.ProcessEnv): AdvisoryRead {
  return () => {
    const config = readConfig(configPath(env));
    return config && (config.shepherd?.repos ?? {});
  };
}

let cachedRoutes: FactoryRoutes | undefined;

/** The production routes, built on first call so a bad config file only fails commands that dispatch steps. */
export function factoryRoutes(): FactoryRoutes {
  cachedRoutes ??= configuredRoutes(process.env);
  return cachedRoutes;
}
