import { ghCliWire, githubPort, type GitHubPort } from "@titan-design/github";
import { fileURLToPath } from "node:url";
import type { Db, Migration } from "@titan-design/store-sqlite";
import type { AuditPorts } from "./audit/ports.js";
import { systemAuditPorts } from "./audit/production.js";
import { auditRoutes } from "./audit/routes.js";
import { measurementAuditWorkflow } from "./audit/workflow.js";
import { ownCheckout } from "./cli-service.js";
import { configPath, factoryStateDir, loadConfig, type FactoryConfig } from "./config.js";
import type { WorkflowDefinition } from "./definition.js";
import type { DatabaseTenant, FactoryRoutes } from "./host.js";
import type { CleanupPorts } from "./shepherd/cleanup.js";
import { reviewCheckPort } from "./shepherd/publish-review.js";
import { activeWorkFixTasks, activeWorkOrigin, activeWorkTasks, agentChatCleanupAgents } from "./shepherd/cleanup-ports.js";
import type { ShepherdServices } from "./shepherd/commands.js";
import { freezeCancelOnlyMigration, freezeGuard, freezeMigration, freezeStoreRef, isFixersPr, recheckedFrozen, type FreezeStoreRef } from "./shepherd/freeze.js";
import { carry } from "./shepherd/tree-carry.js";
import { firstReason, heldCheck, holdSatisfier, holdingPort, openHeadRead, waitWhileHeld, type HoldSatisfier } from "./shepherd/hold.js";
import { agentChatAgents } from "./shepherd/agents.js";
import { configuredExitNotice, type ExitNoticePorts } from "./shepherd/exit-notice.js";
import { spawnGate, type SpawnGate, type SpawnLimits } from "./shepherd/spawn-gate.js";
import { reviewCheckoutRoot } from "./shepherd/review-checkout.js";
import { reviewCheckoutDisk } from "./shepherd/review-checkout-disk.js";
import { fixersOver, type MainRedWiring } from "./shepherd/main-red.js";
import { releaseGuard, type PackageRegistry } from "./shepherd/release.js";
import type { IsFrozen } from "./shepherd/merge-facts.js";
import type { ParkPort } from "./shepherd/park.js";
import { retryingGhServerErrors } from "./shepherd/gh-retry.js";
import { shepherdPrWorkflow, shepherdRoutes } from "./shepherd/pr.js";
import { redeployRoute, systemDeployer, type Deployer } from "./shepherd/redeploy.js";
import { codewatchReader, ghCodewatchReport } from "./shepherd/codewatch-questions.js";
import type { ReviewTarget, ReviewWiring } from "./shepherd/review.js";
import { agentChatReviewerDispatch, type AgentChatReviewerDispatch } from "./shepherd/reviewer-dispatch.js";
import { configuredRoles } from "./shepherd/reviewer-roles.js";
import { agentChatRoster, type RosterReader } from "./shepherd/roster.js";
import { transcriptReviewerReader } from "./shepherd/reviewer-reader.js";
import { loadSeatBook, lookupSeat, type SeatBook } from "./shepherd/seats.js";
import { accountLimitMigration, accountLimitStoreRef, type AccountLimitStoreRef } from "./shepherd/account-store.js";
import { DEFAULT_ACCOUNT, type ReviewAccounts } from "./shepherd/account-limit.js";
import { holdReviewerMigration, holdSatisfiedMigration, lineageMigration, shepherdMigration, sliceMigration, shepherdStoreRef, type ShepherdStoreRef } from "./shepherd/store.js";
import { shepherdEventMigration } from "./shepherd/events.js";
import { leaveTrainToWait, mergeTrainRef, rideTrain, trainLeaveRoute, trainMigration, type MergeTrainRef } from "./shepherd/train.js";
import { sleep } from "./workflows/land.js";
import { landPrRoutes, landPrWorkflow, type LandPrDeps } from "./workflows/land-pr.js";
import { devicePrWorkflow } from "./workflows/device-pr.js";
import { tickPacing, type TickPacing } from "./tick-pacing.js";
import { prSnapshot } from "./workflows/pr-snapshot.js";
import { localBasementSuite, suiteRules, type SuiteRules } from "./shepherd/suite-host.js";

/** Every workflow the CLI hosts. Pilots register here as their slices land (doc-change in S3). */
export const factoryWorkflows: readonly WorkflowDefinition[] = [landPrWorkflow(), shepherdPrWorkflow(), measurementAuditWorkflow(), devicePrWorkflow()];

export interface FactoryRouteDeps extends LandPrDeps {
  port: GitHubPort;
  store: ShepherdStoreRef;
  freeze?: FreezeStoreRef;
  /** The per-repo merge train shepherd-pr runs merge through; defaults to one bound with the store. */
  train?: MergeTrainRef;
  holdPollMs?: number;
  /** Paces the snapshot tick and is reported in `/health`; `configuredRoutes` wires one on the `rate_limit` reading. */
  pacing?: TickPacing;
  agentChatBin?: string;
  /** The Claude config directory successors spawn under; the fixer's, since a successor is a fixer in a new session. */
  agentChatConfigDir?: string;
  /** The one roster reader every port over `agentChatBin` shares; absent means each wake reads through its own. */
  roster?: RosterReader;
  /** The one gate every factory-started agent passes; absent means spawns are not gated. */
  spawnGate?: SpawnGate;
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
}

const NO_SEATS: SeatBook = { seats: [], denied: [] };

/** The shepherd tenant's versions follow the host's 1-3; the host's own later migrations take numbers above these. */
export const SHEPHERD_MIGRATIONS: readonly Migration[] = [shepherdMigration(4), lineageMigration(5), freezeMigration(6), sliceMigration(8), holdReviewerMigration(9), trainMigration(10), holdSatisfiedMigration(11), freezeCancelOnlyMigration(12), shepherdEventMigration(16), accountLimitMigration(17)];

/**
 * Routes for every dispatch step of `factoryWorkflows`, each match once. Every merge goes through the hold, so a held
 * PR never reaches the port's merge, whichever workflow lands it; an unbound store refuses the merge. A shepherd-pr
 * merge then waits for its repo's train, so a held PR never holds the train while it waits, and a run gives the train
 * up before it waits on a retarget.
 */
export function factoryRoutesFor(deps: FactoryRouteDeps): FactoryRoutes {
  const holds = () => deps.store.get();
  const pause = deps.sleep ?? sleep;
  const freeze = deps.freeze ?? freezeStoreRef(deps.now);
  const guard = firstReason(freezeGuard({ freezes: () => freeze.get(), registrations: holds, now: deps.now }), releaseGuard(holds, deps.now));
  const satisfy = holdSatisfierFor(deps);
  const held = heldCheck(deps.port, holds, guard, satisfy, deps.snapshot);
  const train = deps.train ?? mergeTrainRef(deps.now);
  const accountLimits = deps.accountLimits ?? accountLimitStoreRef(deps.now);
  const timing = { sleep: pause, pollMs: deps.holdPollMs, now: deps.now };
  const land = landPrRoutes({ ...deps, port: holdingPort(deps.port, holds, guard, satisfy) }).map((route) => {
    if (route.match === "base-wait") return leaveTrainToWait(route, train);
    return route.match === "merge" ? waitWhileHeld(rideTrain(route, { train, port: deps.port, held, timing }), held, timing, openHeadRead(deps.port, deps.snapshot)) : route;
  });
  const shepherdDeps = { port: deps.port, store: deps.store, now: deps.now ?? Date.now, sleep: pause, pollMs: deps.pollMs, agentChatBin: deps.agentChatBin ?? "agent-chat", agentChatConfigDir: deps.agentChatConfigDir, roster: deps.roster, spawnGate: deps.spawnGate, cleanup: deps.cleanup, snapshot: deps.snapshot, reviewCheck: deps.reviewCheck, exitNotice: deps.exitNotice, suiteRules: deps.suiteRules, accountLimits };
  const review = deps.review && { ...deps.review, isFrozen: deps.isFrozen ?? recheckedFrozen(deps.port, () => freeze.get(), holds, deps.now) };
  const shepherd = shepherdRoutes(shepherdDeps, { review, park: deps.park, registry: deps.registry, mainRed: { ...deps.mainRed, freezes: () => freeze.get() } });
  const database: DatabaseTenant = { extraMigrations: SHEPHERD_MIGRATIONS, bind: (db) => bindAll(db, deps.store, freeze, train, accountLimits) };
  const services: ShepherdServices = { store: deps.store, port: deps.port, seats: deps.seats ?? (() => NO_SEATS), train, freeze, snapshot: deps.snapshot, pacing: deps.pacing };
  return Object.assign([...retryingGhServerErrors([...land, ...shepherd], { sleep: pause }), trainLeaveRoute(train, shepherdDeps.now), redeployRoute(shepherdDeps.now, deps.redeploy), ...auditRoutes(deps.audit ?? systemAuditPorts(ownCheckout()))], { database, shepherd: services });
}

/** A hold's named reviewer is read through the review wiring's roster and reader; with no dispatch wired no hold is ever satisfied. */
function holdSatisfierFor(deps: FactoryRouteDeps): HoldSatisfier | undefined {
  const dispatch = deps.review?.dispatch;
  if (!deps.review || !dispatch) return undefined;
  return holdSatisfier({ store: () => deps.store.get(), roster: () => dispatch.roster(), reader: deps.review.reader, carry: (input) => carry(input, deps.review?.carry) });
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

/** The checkout a seat binds to `repo`, as the seat file writes it; a denied repo or one no seat lists has none. */
function checkoutPath(book: SeatBook, repo: string): string | undefined {
  const found = lookupSeat(book, repo);
  return found.kind === "seat" ? found.seat.paths[repo.toLowerCase()] : undefined;
}

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

type ReviewConfigured = NonNullable<NonNullable<FactoryConfig["shepherd"]>["review"]>;

/** Tells every seat that owns `repo` over agent-chat; a repo no seat owns has nobody to tell, which throws so the alert is tried again. */
function seatAlert(agentChatBin: string, seats: () => SeatBook, roster: RosterReader | undefined) {
  const agents = agentChatAgents(agentChatBin, { roster });
  return async (repo: string, text: string): Promise<void> => {
    const found = lookupSeat(seats(), repo);
    if (found.kind !== "seat") throw new Error(`no seat owns ${repo}`);
    for (const name of found.seat.name.split("+")) await agents.message(name, text);
  };
}

/** `review.configDir` first, then each fallback; every account gets its own dispatch over the one roster and spawn gate. */
function reviewAccounts(review: ReviewConfigured, under: (configDir: string | undefined) => AgentChatReviewerDispatch, alert: ReviewAccounts["alert"]): { primary: AgentChatReviewerDispatch; accounts: ReviewAccounts } {
  const first = review.configDir ?? DEFAULT_ACCOUNT;
  const primary = under(review.configDir);
  const dirs = [...new Set([first, ...(review.fallbackConfigDirs ?? [])])];
  const byDir = new Map(dirs.map((dir) => [dir, dir === first ? primary : under(dir)]));
  return { primary, accounts: { dirs, dispatchUnder: (dir) => byDir.get(dir) ?? primary, alert } };
}

/** One dispatch serves both halves, so the reader finds the reviewer on the roster that started it. No `review` key starts nothing. */
function configuredReview(shepherd: FactoryConfig["shepherd"], seats: () => SeatBook, roster: RosterReader | undefined, gate: SpawnGate, isFixer: (target: ReviewTarget) => boolean): FactoryRouteDeps["review"] {
  const { agentChatBin, review } = shepherd ?? {};
  if (!review || !agentChatBin) return undefined;
  const under = (configDir: string | undefined) => agentChatReviewerDispatch({ agentChatBin, roles: configuredRoles(review), configDir, cwdFor: (repo) => checkoutPath(seats(), repo), roster, gate, isFixer });
  const { primary: dispatch, accounts } = reviewAccounts(review, under, seatAlert(agentChatBin, seats, roster));
  const codewatch = review.codewatchRepos && codewatchReader(ghCodewatchReport(), review.codewatchRepos);
  return { dispatch, accounts, reader: transcriptReviewerReader({ roster: dispatch.roster }), timeoutMs: review.verdictTimeoutMs, sessionStartTimeoutMs: review.sessionStartTimeoutMs, reviewAppId: shepherd?.reviewCheck?.appId, roles: configuredRoles(review), ...(codewatch && { codewatch }) };
}

/** Cleanup retires agents through the configured `agent-chat`, so no binary configured means no retire and no task close. */
function configuredCleanup(shepherd: FactoryConfig["shepherd"], env: NodeJS.ProcessEnv, roster: RosterReader | undefined): CleanupPorts | undefined {
  const agentChatBin = shepherd?.agentChatBin;
  if (!agentChatBin) return undefined;
  return { agents: agentChatCleanupAgents(agentChatBin, undefined, undefined, roster), tasks: activeWorkTasks({ origin: activeWorkOrigin(env) }) };
}

/** Fix tasks go over active-work's loopback rpc; a fixer needs the configured `agent-chat`. */
function configuredMainRed(shepherd: FactoryConfig["shepherd"], env: NodeJS.ProcessEnv, roster: RosterReader | undefined, gate: SpawnGate): FactoryRouteDeps["mainRed"] {
  const agentChatBin = shepherd?.agentChatBin;
  return { tasks: activeWorkFixTasks({ origin: activeWorkOrigin(env) }), ...(agentChatBin && { fixers: fixersOver(agentChatAgents(agentChatBin, { configDir: shepherd.fixer?.configDir, roster, gate })) }) };
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

/**
 * The production route set: the post-merge chore and the reviewer come from the config file; the seat book is re-read per
 * registration and per spawn. Every port over the configured `agent-chat` shares one roster reader, so concurrent runs
 * start at most one `agent ls` per TTL window.
 */
export function configuredRoutes(env: NodeJS.ProcessEnv, overrides: Partial<FactoryRouteDeps> = {}): FactoryRoutes {
  const { postMerge, shepherd } = loadConfig(configPath(env));
  const seats = overrides.seats ?? ((): SeatBook => loadSeatBook(loadConfig(configPath(env)).shepherd ?? {}));
  const agentChatBin = shepherd?.agentChatBin;
  const roster = overrides.roster ?? (agentChatBin ? agentChatRoster(agentChatBin, { now: overrides.now }) : undefined);
  const gate = overrides.spawnGate ?? spawnGate({ limits: configuredSpawnLimits(shepherd), disk: reviewCheckoutDisk(reviewCheckoutRoot()) });
  const store = overrides.store ?? shepherdStoreRef();
  const freeze = overrides.freeze ?? freezeStoreRef(overrides.now);
  const review = configuredReview(shepherd, seats, roster, gate, fixerReview(freeze, store));
  const cleanup = configuredCleanup(shepherd, env, roster);
  const mainRed = configuredMainRed(shepherd, env, roster, gate);
  const exitNotice = agentChatBin ? configuredExitNotice(seats, agentChatAgents(agentChatBin, { roster }), shepherd?.hubSeat) : undefined;
  const redeploy = systemDeployer({ bin: ownBin(), stateDir: factoryStateDir(env) });
  const port = overrides.port ?? githubPort(ghCliWire());
  const pacing = tickPacing({ now: overrides.now });
  const snapshot = prSnapshot(port, { now: overrides.now, tickMs: pacing.tickMs });
  return factoryRoutesFor({ port, snapshot, pacing, store, freeze, postMerge, review, agentChatBin, agentChatConfigDir: shepherd?.fixer?.configDir, roster, spawnGate: gate, cleanup, mainRed, redeploy, exitNotice, flakyChecks: lowerKeys(shepherd?.flakyChecks), reviewCheck: reviewCheckPort(shepherd?.reviewCheck), suiteRules: suiteRules(localBasementSuite(env)), ...overrides, seats });
}

let cachedRoutes: FactoryRoutes | undefined;

/** The production routes, built on first call so a bad config file only fails commands that dispatch steps. */
export function factoryRoutes(): FactoryRoutes {
  cachedRoutes ??= configuredRoutes(process.env);
  return cachedRoutes;
}
