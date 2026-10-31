import { githubPort, octokitWire, sharedOctokit, type GitHubPort } from "@titan-design/github";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Db, Migration } from "@titan-design/store-sqlite";
import type { AuditPorts } from "./audit/ports.js";
import { systemAuditPorts } from "./audit/production.js";
import { auditRoutes } from "./audit/routes.js";
import { measurementAuditWorkflow } from "./audit/workflow.js";
import { deployCheckoutAncestry } from "./build-ancestry.js";
import { deployCheckoutFor, ownCheckout } from "./cli-service.js";
import { configPath, factoryStateDir, loadConfig, readConfig, type FactoryConfig, type ShepherdRepoConfig } from "./config.js";
import { configRef, current, liveField, type ConfigRef, type Live } from "./config-ref.js";
import { configuredMainWatch } from "./main-watch-ports.js";
import { holdAdversary, liveSpawnLimits, reviewAccounts, successorAccounts, visualThresholdOf, withHoldAdversary } from "./workflows-live.js";
import type { WorkflowDefinition } from "./definition.js";
import type { DatabaseTenant, FactoryRoutes } from "./host.js";
import type { CleanupPorts, TaskClose } from "./shepherd/cleanup.js";
import { reviewCheckPort } from "./shepherd/publish-review.js";
import { activeWorkFixTasks, activeWorkOrigin, activeWorkTasks, agentChatCleanupAgents } from "./shepherd/cleanup-ports.js";
import type { ShepherdServices } from "./shepherd/commands.js";
import { ghGateway, type GhCallLine, type GhGateway } from "./shepherd/gh-gateway.js";
import type { PrFilesRead } from "./shepherd/git-pr-files.js";
import { inheritedRedCheck } from "./shepherd/inherited-red.js";
import { freezeCancelOnlyMigration, freezeFixPrMigration, freezeGuard, freezeMigration, freezeStoreRef, isFixersPr, recheckedFrozen, type FreezeStoreRef } from "./shepherd/freeze.js";
import { carry } from "./shepherd/tree-carry.js";
import { adversaryGuard } from "./shepherd/adversary-guard.js";
import { firstReason, heldCheck, holdSatisfier, holdingPort, openHeadRead, waitWhileHeld, type HoldSatisfier } from "./shepherd/hold.js";
import { agentChatAgents, installedHeadless } from "./shepherd/agents.js";
import { configuredExitNotice, type ExitNoticePorts } from "./shepherd/exit-notice.js";
import { machineStopWatch, type MachineStopWatch } from "./shepherd/machine-stop.js";
import { readMachine, spawnGate, type SpawnGate, type SpawnLimits } from "./shepherd/spawn-gate.js";
import { movedPastOnList, openHeadOnPort } from "./shepherd/review-queue.js";
import { reviewCheckoutRoot } from "./shepherd/review-checkout.js";
import { reviewCheckoutDisk } from "./shepherd/review-checkout-disk.js";
import { workflowModeOf } from "./shepherd/review-shadow.js";
import { fixersOver, type MainRedWiring } from "./shepherd/main-red.js";
import { releaseGuard, type PackageRegistry } from "./shepherd/release.js";
import type { VersionRegistry } from "./shepherd/release-follow.js";
import type { IsFrozen } from "./shepherd/merge-facts.js";
import type { ParkPort } from "./shepherd/park.js";
import { retryingGhServerErrors } from "./shepherd/gh-retry.js";
import { mergeOrderGuard } from "./shepherd/merge-order-guard.js";
import { orderExpiryRoute } from "./shepherd/merge-order-expiry.js";
import { mergeOrderRoutes } from "./shepherd/merge-order-steps.js";
import { fileRules, mergeOrderMigration, mergeOrderRef, type MergeOrderRules, type OrderWaits } from "./shepherd/merge-order.js";
import { watchListMigration } from "./shepherd/watch-list.js";
import { gateEvidenceMigration } from "./shepherd/lan-gates.js";
import { mergeBaseExceptionMigration } from "./shepherd/merge-base-exception.js";
import { shepherdPrWorkflow, shepherdRoutes } from "./shepherd/pr.js";
import { redeployRoute, systemDeployer, type Deployer } from "./shepherd/redeploy.js";
import { codewatchReader, ghCodewatchReport } from "./shepherd/codewatch-questions.js";
import type { ReviewTarget, ReviewWiring } from "./shepherd/review.js";
import { agentChatReviewerDispatch } from "./shepherd/reviewer-dispatch.js";
import { configuredRoles } from "./shepherd/reviewer-roles.js";
import { agentChatRoster, type RosterReader } from "./shepherd/roster.js";
import { transcriptReviewerReader } from "./shepherd/reviewer-reader.js";
import { boundCheckout, loadSeatBook, lookupSeat, seatBaselineCheck, type SeatBook } from "./shepherd/seats.js";
import { advisoryGuard, advisoryPort, advisoryUpdates, stickyAdvisory, type AdvisoryRead, type IsAdvisory } from "./shepherd/advisory.js";
import { advisoryFile } from "./shepherd/advisory-file.js";
import { configuredStackRestack, type StackRestackOn } from "./shepherd/stack-land.js";
import { configuredStatusContexts, withStatusChecks } from "./shepherd/status-checks.js";
import { accountLimitMigration, accountLimitStoreRef, type AccountLimitStoreRef } from "./shepherd/account-store.js";
import { proofWaiverMigration } from "./shepherd/proof-waiver.js";
import { planApprovalMigration } from "./shepherd/plan-approval.js";
import { repoFreezeMigration } from "./shepherd/repo-freeze.js";
import { holdReviewerMigration, holdSatisfiedMigration, holdSlotsMigration, lastSliceMigration, lineageMigration, ownerHoldMigration, parkSettledMigration, registrantMigration, registrationFactsMigration, repairStopMigration, reviewRequestMigration, shepherdMigration, sliceMigration, shepherdStoreRef, type ShepherdStoreRef } from "./shepherd/store.js";
import { gateCancelKindMigration, orderEventKindsMigration, orderWaitKindMigration, reclassMarkMigration, shepherdEventMigration } from "./shepherd/events.js";
import { reviewPendingAt } from "./shepherd/review-request.js";
import { g10Recheck } from "./shepherd/g10-release.js";
import { leaveTrainToWait, mergeTrainRef, rideTrain, trainLeaveRoute, trainMigration, type MergeTrainRef } from "./shepherd/train.js";
import { shadowRefresh, trainShadowMigration, trainShadowRef } from "./shepherd/train-shadow.js";
import { shadowHeldCheck } from "./shepherd/train-shadow-held.js";
import { sleep } from "./workflows/land.js";
import { landPrRoutes, landPrWorkflow, type LandPrDeps } from "./workflows/land-pr.js";
import { withAutoresearch } from "./autoresearch/configured.js";
import { chorePruning } from "./workflows/chore-prune.js";
import { systemChorePorts } from "./workflows/post-merge-chore.js";
import { devicePrWorkflow } from "./workflows/device-pr.js";
import { buildSurfaceRoutes, buildSurfaceWorkflow, factoryBuildPorts } from "./build-surface/index.js";
import { tickPacing, type TickPacing } from "./tick-pacing.js";
import { portReads, prSnapshot } from "./workflows/pr-snapshot.js";
import { pushSignal } from "./shepherd/push-signal.js";
import { localBasementSuite, suiteRules, type SuiteRules } from "./shepherd/suite-host.js";
import type { ThawAlertPorts, VisualDeliveryWatch } from "./shepherd/services.js";
import type { VisualThreshold } from "./shepherd/visual-delta-read.js";
import { configuredVisualDelivery } from "./shepherd/visual-delivery-sweep.js";
import type { VisualPacketPorts } from "./shepherd/visual-packet-trigger.js";
import type { DiagnosisPorts } from "./shepherd/no-verdict-diagnosis.js";
import { configuredDiagnosis, configuredVisualPacket } from "./workflows-spawned.js";

/** Every workflow the CLI hosts. Pilots register here as their slices land (doc-change in S3). */
export const factoryWorkflows: readonly WorkflowDefinition[] = [landPrWorkflow(), shepherdPrWorkflow(), measurementAuditWorkflow(), devicePrWorkflow(), buildSurfaceWorkflow()];

export interface FactoryRouteDeps extends LandPrDeps {
  port: GitHubPort;
  store: ShepherdStoreRef;
  freeze?: FreezeStoreRef;
  /** The per-repo merge train shepherd-pr runs merge through; defaults to one bound with the store. */
  train?: MergeTrainRef;
  holdPollMs?: number;
  /** Paces the snapshot tick and is reported in `/health`; `configuredRoutes` wires one on the `rate_limit` reading. */
  pacing?: TickPacing;
  /** Reads a head's changed files from Shepherd's git cache; absent means the serve process's cached reader. */
  prFiles?: PrFilesRead;
  agentChatBin?: string;
  /** The Claude config directory successors spawn under; the fixer's, since a successor is a fixer in a new session. */
  agentChatConfigDir?: string;
  /** The one roster reader every port over `agentChatBin` shares; absent means each wake reads through its own. */
  roster?: RosterReader;
  /** The one gate every factory-started agent passes; absent means spawns are not gated. */
  spawnGate?: SpawnGate;
  /** The one ledger of machine stops the spawn gate and the broker's refusals feed, read when a reviewer ends with no verdict. */
  machineStop?: MachineStopWatch;
  /** The seat book `shepherd.register` resolves policy against; defaults to no seats, so every repo is owner-gated. */
  seats?: () => SeatBook;
  /** The reviewer reader and dispatch; absent means `sh-review` answers none and the owner gate decides. */
  review?: Omit<ReviewWiring, "isFrozen">;
  /** Read by the merge evidence step, which runs only after a wired review; defaults to no repo frozen. */
  isFrozen?: IsFrozen;
  /** The task and agent ports `sh-cleanup` uses; absent means it deletes the head ref only. */
  cleanup?: CleanupPorts;
  /** How `sh-park` parks the implementer's worktree; defaults to `agent-chat agent park`. */
  park?: ParkPort;
  /** Where the release preflight looks packages up; defaults to registry.npmjs.org. */
  registry?: PackageRegistry;
  /** Where a merged release's versions are looked up; defaults to registry.npmjs.org. */
  versions?: VersionRegistry;
  /** The fix-task and fixer ports a red main uses; absent ports still freeze, and leave the rest to the owner. */
  mainRed?: Omit<MainRedWiring, "freezes">;
  /** The App-token port `sh-publish-review` posts through; absent means it records `published: false`. */
  reviewCheck?: GitHubPort;
  /** Starts `service deploy` after a green merge into the factory's own repo; absent means sh-redeploy spawns nothing. */
  redeploy?: Deployer;
  /** Which reviewer accounts are out of usage; defaults to one bound with the store. */
  accountLimits?: AccountLimitStoreRef;
  /** Tells a repo's seat that a woken fixer exited with no push; absent means the owner gate takes every such exit. */
  exitNotice?: ExitNoticePorts;
  /** The test rules Shepherd's briefs carry; `configuredRoutes` resolves them once from the host serve starts on. */
  suiteRules?: SuiteRules;
  /** What measurement-audit reads and asks; defaults to this checkout's machine and `claude -p`. */
  audit?: AuditPorts;
  /** Repos whose merges, branch updates and pushes Shepherd never makes; defaults to none. */
  advisory?: IsAdvisory;
  /** Repos whose stacked children Shepherd restacks after its own merge; defaults to none. */
  stackRestack?: StackRestackOn;
  /** Serve's GitHub gateway for `shepherd.ghRead` and `shepherd.ghBudget`; absent means those refuse as unavailable. */
  gateway?: GhGateway;
  /** `on` lets a g10 hold gate only the merge, so a held run repairs as usual; absent means `off`. A getter is read per check. */
  heldRepair?: Live<"off" | "on" | undefined>;
  /** `on` lets a vacuous fix-proof on a test-only PR with a tests-only diff proceed to review; absent means `off`. A getter is read per check. */
  noReproProceed?: Live<"off" | "on" | undefined>;
  /** `record-fact` sends a NO_REPRO on a diff with no source path on to review; absent means `keep-owner`. A getter is read per check. */
  nonSourceNoRepro?: Live<"keep-owner" | "record-fact" | undefined>;
  /** `last-slice-only` closes a merged PR's task only on its last slice; absent means `keep`, every merge closes. A getter is read per cleanup. */
  taskClose?: Live<TaskClose | undefined>;
  /** `shepherd.visualPacket` and the ports its spawn uses; absent means `off`. */
  visualPacket?: VisualPacketPorts;
  /** The planner failed rounds with no adversary verdict spawn; absent means ops hears instead. */
  diagnosis?: DiagnosisPorts;
  /** `shepherd.visualDelivery`'s sweep, carried to serve on the services; absent means none runs. */
  visualDelivery?: VisualDeliveryWatch;
  /** True when `shepherd.consoleAnswers` is configured: approve-merge gates then offer `send-back`. */
  consoleAnswers?: boolean;
  /** Where `shepherd thaw` alerts the repo's red seat; absent means each hand thaw only logs its alert. */
  thawAlert?: ThawAlertPorts;
  /** Which repos order overlapping merges behind a conflicted PR's reservation; absent means `merge-order.json`. */
  mergeOrderRules?: MergeOrderRules;
  /** `shepherd.visualThreshold` for `shepherd visual-delta`; absent means the review wiring's, and with neither that command refuses. */
  visualThreshold?: (repo: string) => VisualThreshold | undefined;
}

const NO_SEATS: SeatBook = { seats: [], denied: [] };

/** The shepherd tenant's versions follow the host's 1-3; the host's own later migrations take numbers above these. */
export const SHEPHERD_MIGRATIONS: readonly Migration[] = [shepherdMigration(4), lineageMigration(5), freezeMigration(6), sliceMigration(8), holdReviewerMigration(9), trainMigration(10), holdSatisfiedMigration(11), freezeCancelOnlyMigration(12), shepherdEventMigration(16), accountLimitMigration(17), reviewRequestMigration(18), holdSlotsMigration(19), parkSettledMigration(21), ownerHoldMigration(22), freezeFixPrMigration(23), registrationFactsMigration(24), reclassMarkMigration(25), trainShadowMigration(26), repairStopMigration(31), proofWaiverMigration(32), repoFreezeMigration(33), registrantMigration(38), gateCancelKindMigration(39), mergeOrderMigration(40), watchListMigration(41), mergeBaseExceptionMigration(42), lastSliceMigration(43), orderEventKindsMigration(44), orderWaitKindMigration(45), planApprovalMigration(46), gateEvidenceMigration(48)];

/**
 * Routes for every dispatch step of `factoryWorkflows`, each match once. Every merge goes through the hold, so a held
 * PR never reaches the port's merge, whichever workflow lands it; an unbound store refuses the merge. A shepherd-pr
 * merge then waits for its repo's train, so a held PR never holds the train while it waits, and a run gives the train
 * up before it waits on a retarget. An advisory repo's merge and update wait held, and its port refuses every write
 * to a branch, whichever route reaches it.
 */
export function factoryRoutesFor(given: FactoryRouteDeps): FactoryRoutes {
  const isAdvisory = given.advisory ?? (() => false);
  const deps = { ...given, port: advisoryPort(given.port, isAdvisory) };
  const holds = () => deps.store.get();
  const pause = deps.sleep ?? sleep;
  const freeze = deps.freeze ?? freezeStoreRef(deps.now);
  const order = mergeOrderRef();
  const orderRules = deps.mergeOrderRules ?? fileRules;
  const orderWaits: OrderWaits = new Map();
  const ordered = mergeOrderGuard({ order: () => order.get(), registrations: holds, rules: orderRules, now: deps.now, waits: orderWaits });
  const adversary = adversaryGuard({ store: holds, carry: (input) => carry(input, deps.review?.carry) });
  const guard = firstReason(advisoryGuard(isAdvisory), freezeGuard({ freezes: () => freeze.get(), registrations: holds, now: deps.now }), releaseGuard(holds, deps.now), adversary, ordered);
  const satisfy = holdSatisfierFor(deps);
  const held = heldCheck(deps.port, holds, guard, satisfy, deps.snapshot);
  const train = deps.train ?? mergeTrainRef(deps.now);
  const accountLimits = deps.accountLimits ?? accountLimitStoreRef(deps.now);
  const timing = { sleep: pause, pollMs: deps.holdPollMs, now: deps.now };
  const shadow = { shadow: trainShadowRef(), port: deps.port, reads: deps.snapshot ?? portReads(deps.port), held: shadowHeldCheck({ port: deps.port, holds, freezes: () => freeze.get(), advisory: isAdvisory, now: deps.now, snapshot: deps.snapshot }), advisory: isAdvisory, now: deps.now ?? Date.now };
  const shepherdDeps = { port: deps.port, advisory: isAdvisory, store: deps.store, now: deps.now ?? Date.now, sleep: pause, pollMs: deps.pollMs, agentChatBin: deps.agentChatBin ?? "agent-chat", agentChatConfigDir: deps.agentChatConfigDir, successorAccounts: successorAccounts(deps.agentChatConfigDir, deps.review?.accounts), roster: deps.roster, spawnGate: deps.spawnGate, cleanup: deps.cleanup, snapshot: deps.snapshot, pushes: deps.pushes, reviewCheck: deps.reviewCheck, exitNotice: deps.exitNotice, suiteRules: deps.suiteRules, accountLimits, prFiles: deps.prFiles, stackRestack: deps.stackRestack, get heldRepair() { return current(deps.heldRepair); }, get noReproProceed() { return current(deps.noReproProceed); }, get nonSourceNoRepro() { return current(deps.nonSourceNoRepro); }, get taskClose() { return current(deps.taskClose); }, visualPacket: deps.visualPacket, diagnosis: deps.diagnosis, consoleAnswers: deps.consoleAnswers, visualBaselineCheck: (repo: string) => seatBaselineCheck(deps.seats?.() ?? NO_SEATS, repo) };
  const land = landPrRoutes({ ...deps, port: holdingPort(deps.port, holds, guard, satisfy), inheritedRed: inheritedRedCheck(shepherdDeps, () => freeze.get()) }).map((route) => {
    if (route.match === "base-wait") return leaveTrainToWait(route, train);
    if (route.match === "update-branch") return shadowRefresh(advisoryUpdates(route, isAdvisory, timing), shadow);
    return route.match === "merge" ? waitWhileHeld(rideTrain(route, { train, port: deps.port, held, timing }), held, timing, openHeadRead(deps.port, deps.snapshot), (repo, pr, sha) => reviewPendingAt(holds().byPr(repo, pr), sha), adversary.takeRehold, g10Recheck(holds)) : route;
  });
  const review = deps.review && withHoldAdversary({ ...deps.review, isFrozen: deps.isFrozen ?? recheckedFrozen(deps.port, () => freeze.get(), holds, deps.now) }, deps.review);
  const shepherd = shepherdRoutes(shepherdDeps, { review, park: deps.park, registry: deps.registry, versions: deps.versions, mainRed: { ...deps.mainRed, freezes: () => freeze.get() } });
  const database: DatabaseTenant = { extraMigrations: SHEPHERD_MIGRATIONS, bind: (db) => bindAll(db, deps.store, freeze, train, accountLimits, shadow.shadow, order) };
  const services: ShepherdServices = { store: deps.store, port: deps.port, seats: deps.seats ?? (() => NO_SEATS), train, freeze, snapshot: deps.snapshot, pacing: deps.pacing, now: shepherdDeps.now, prFiles: deps.prFiles, gateway: deps.gateway, ...(deps.spawnGate && { reviewSlots: deps.spawnGate.reviewSlots }), ...(deps.visualDelivery && { visualDelivery: deps.visualDelivery }), ...(deps.thawAlert && { thawAlert: deps.thawAlert }), mergeOrder: { order: () => order.get(), holds, rules: orderRules, waits: orderWaits, now: shepherdDeps.now }, ...(deps.roster && { roster: deps.roster }), visualThreshold: deps.visualThreshold ?? deps.review?.visualThreshold };
  return Object.assign([...retryingGhServerErrors([...land, ...shepherd], { sleep: pause }), trainLeaveRoute(train, shepherdDeps.now), ...mergeOrderRoutes({ order: () => order.get(), holds, rules: orderRules, port: deps.port, train, timing, now: shepherdDeps.now }), orderExpiryRoute({ order: () => order.get(), rules: orderRules, now: shepherdDeps.now }), redeployRoute(shepherdDeps.now, deps.redeploy), ...auditRoutes(deps.audit ?? systemAuditPorts(ownCheckout())), ...buildSurfaceRoutes(factoryBuildPorts({ ...deps, agentChatBin: shepherdDeps.agentChatBin }))], { database, shepherd: services });
}

/** A hold's named reviewer is read through the review wiring's roster and reader; with no dispatch wired no hold is ever satisfied. */
function holdSatisfierFor(deps: FactoryRouteDeps): HoldSatisfier | undefined {
  const dispatch = deps.review?.dispatch;
  if (!deps.review || !dispatch) return undefined;
  const { lineage, reader } = deps.review;
  return holdSatisfier({ store: () => deps.store.get(), roster: () => dispatch.roster(), lineage, reader, carry: (input) => carry(input, deps.review?.carry) });
}

/** All or none: a bind that throws unbinds the refs bound before it, so no store stays bound to a database the host never opened. */
export function bindAll(db: Db, ...refs: { bind(db: Db): () => void }[]): () => void {
  const unbinds: (() => void)[] = [];
  try {
    for (const ref of refs) unbinds.push(ref.bind(db));
  } catch (error) {
    unbinds.reverse().forEach((unbind) => unbind());
    throw error;
  }
  return () => unbinds.forEach((unbind) => unbind());
}

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
function configuredReview(shepherd: FactoryConfig["shepherd"], config: ConfigRef, seats: () => SeatBook, repos: UnseatedRepos, roster: RosterReader | undefined, gate: SpawnGate, isFixer: (target: ReviewTarget) => boolean, machineStop: MachineStopWatch): FactoryRouteDeps["review"] {
  const { agentChatBin, review } = shepherd ?? {};
  if (!review || !agentChatBin) return undefined;
  const under = (configDir: string | undefined, fallbackConfigDirs?: () => readonly string[]) => agentChatReviewerDispatch({ agentChatBin, roles: configuredRoles(review), configDir, fallbackConfigDirs, cwdFor: (repo) => boundCheckout(seats(), repo, repos()), roster, gate, isFixer, onMachineHold: machineStop.note });
  const { primary: dispatch, accounts } = reviewAccounts(review, liveField(config, "shepherd.review.fallbackConfigDirs"), under, seatAlert(agentChatBin, seats, roster));
  const codewatch = review.codewatchRepos && codewatchReader(ghCodewatchReport(), review.codewatchRepos);
  const wiring = { dispatch, lineage: dispatch.lineage, accounts, reader: transcriptReviewerReader({ roster: dispatch.roster }), timeoutMs: review.verdictTimeoutMs, sessionStartTimeoutMs: review.sessionStartTimeoutMs, reviewAppId: shepherd?.reviewCheck?.appId, roles: configuredRoles(review), machineStop, profileInstalled: (profile: string) => installedHeadless(profile), visualThreshold: visualThresholdOf(config), ...(codewatch && { codewatch }), ...(review.panel && { panel: review.panel }), ...(review.scopedRereview && { scopedRereview: review.scopedRereview }), ...(review.scopeCheck && { scopeCheck: review.scopeCheck }), ...workflowModeOf(review.workflow) };
  return withHoldAdversary(wiring, holdAdversary(review, config, under));
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
  const limits = liveSpawnLimits(configuredSpawnLimits(shepherd), config);
  const machineStop = overrides.machineStop ?? machineStopWatch({ read: () => readMachine(), limits });
  const client = sharedOctokit();
  const port = withStatusChecks(overrides.port ?? githubPort(octokitWire({ client })), configuredStatusContexts(() => config.get().shepherd?.repos));
  const pacing = tickPacing({ now: overrides.now });
  const snapshot = prSnapshot(port, { now: overrides.now, tickMs: pacing.tickMs });
  const movedPast = movedPastOnList((repo) => snapshot.cachedOpen?.(repo));
  const gate = overrides.spawnGate ?? spawnGate({ limits, disk: reviewCheckoutDisk(reviewCheckoutRoot()), onStop: machineStop.note, movedPast, liveHead: openHeadOnPort(port) });
  const store = overrides.store ?? shepherdStoreRef();
  const freeze = overrides.freeze ?? freezeStoreRef(overrides.now);
  const review = configuredReview(shepherd, config, seats, repos, roster, gate, fixerReview(freeze, store), machineStop);
  const cleanup = configuredCleanup(shepherd, env, roster);
  const mainRed = configuredMainRed(shepherd, env, roster, gate);
  const exitNotice = agentChatBin ? configuredExitNotice(seats, agentChatAgents(agentChatBin, { roster }), { hubSeat: shepherd.hubSeat, redSeat: shepherd.redSeat }, store) : undefined;
  const redeploy = systemDeployer({ bin: ownBin(), stateDir: factoryStateDir(env), isAncestor: deployCheckoutAncestry(deployCheckoutFor(env)) });
  const gateway = ghGateway({ client, snapshot, onCall: logGhCall });
  const pushes = pushSignal((repo) => boundCheckout(seats(), repo, repos()));
  const cwdFor = (repo: string) => boundCheckout(seats(), repo, repos());
  const chores = systemChorePorts({ dir: join(factoryStateDir(env), "chores"), wrapper: [process.execPath, ownChoreMain()] });
  const routes = factoryRoutesFor({ port, snapshot, pushes, pacing, gateway, store, freeze, postMerge, chores, review, agentChatBin, agentChatConfigDir: shepherd?.fixer?.configDir, roster, spawnGate: gate, cleanup, mainRed, redeploy, exitNotice, flakyChecks: lowerKeys(shepherd?.flakyChecks), reviewCheck: reviewCheckPort(shepherd?.reviewCheck), suiteRules: suiteRules(localBasementSuite(env)), advisory: stickyAdvisory(configuredAdvisory(env), advisoryFile(factoryStateDir(env))), stackRestack: configuredStackRestack(() => readConfig(configPath(env))?.shepherd?.repos), heldRepair: liveField(config, "shepherd.gateReset.heldRepair"), noReproProceed: liveField(config, "shepherd.gateReset.noReproProceed"), nonSourceNoRepro: liveField(config, "shepherd.gateReset.nonSourceNoRepro"), taskClose: liveField(config, "shepherd.taskClose"), visualPacket: configuredVisualPacket(shepherd, env, roster, gate, cwdFor), diagnosis: configuredDiagnosis(shepherd, env, roster, gate, cwdFor), visualDelivery: configuredVisualDelivery(shepherd, env, roster, cwdFor, digest?.push), consoleAnswers: shepherd?.consoleAnswers !== undefined, thawAlert: configuredMainWatch(env), visualThreshold: visualThresholdOf(config), ...overrides, seats });
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
