import { ghCliWire, githubPort, type GitHubPort } from "@titan-design/github";
import { fileURLToPath } from "node:url";
import type { Db, Migration } from "@titan-design/store-sqlite";
import { configPath, factoryStateDir, loadConfig, type FactoryConfig } from "./config.js";
import type { WorkflowDefinition } from "./definition.js";
import type { DatabaseTenant, FactoryRoutes } from "./host.js";
import type { CleanupPorts } from "./shepherd/cleanup.js";
import { activeWorkFixTasks, activeWorkOrigin, activeWorkTasks, agentChatCleanupAgents } from "./shepherd/cleanup-ports.js";
import type { ShepherdServices } from "./shepherd/commands.js";
import { freezeGuard, freezeMigration, freezeStoreRef, type FreezeStoreRef } from "./shepherd/freeze.js";
import { firstReason, heldCheck, holdSatisfier, holdingPort, waitWhileHeld, type HoldSatisfier } from "./shepherd/hold.js";
import { agentChatFixers, type MainRedWiring } from "./shepherd/main-red.js";
import { releaseGuard, type PackageRegistry } from "./shepherd/release.js";
import type { IsFrozen } from "./shepherd/merge-facts.js";
import type { ParkPort } from "./shepherd/park.js";
import { shepherdPrWorkflow, shepherdRoutes } from "./shepherd/pr.js";
import { redeployRoute, systemDeployer, type Deployer } from "./shepherd/redeploy.js";
import type { ReviewWiring } from "./shepherd/review.js";
import { agentChatReviewerDispatch } from "./shepherd/reviewer-dispatch.js";
import { transcriptReviewerReader } from "./shepherd/reviewer-reader.js";
import { loadSeatBook, lookupSeat, type SeatBook } from "./shepherd/seats.js";
import { holdReviewerMigration, holdSatisfiedMigration, lineageMigration, shepherdMigration, sliceMigration, shepherdStoreRef, type ShepherdStoreRef } from "./shepherd/store.js";
import { mergeTrainRef, rideTrain, trainLeaveRoute, trainMigration, type MergeTrainRef } from "./shepherd/train.js";
import { sleep } from "./workflows/land.js";
import { landPrRoutes, landPrWorkflow, type LandPrDeps } from "./workflows/land-pr.js";

/** Every workflow the CLI hosts. Pilots register here as their slices land (doc-change in S3). */
export const factoryWorkflows: readonly WorkflowDefinition[] = [landPrWorkflow(), shepherdPrWorkflow()];

export interface FactoryRouteDeps extends LandPrDeps {
  port: GitHubPort;
  store: ShepherdStoreRef;
  freeze?: FreezeStoreRef;
  /** The per-repo merge train shepherd-pr runs merge through; defaults to one bound with the store. */
  train?: MergeTrainRef;
  holdPollMs?: number;
  agentChatBin?: string;
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
  /** Starts `service deploy` after a green merge into the factory's own repo; absent means sh-redeploy spawns nothing. */
  redeploy?: Deployer;
}

const NO_SEATS: SeatBook = { seats: [], denied: [] };

/** The shepherd tenant's versions follow the host's 1-3; the host's own later migrations take numbers above these. */
export const SHEPHERD_MIGRATIONS: readonly Migration[] = [shepherdMigration(4), lineageMigration(5), freezeMigration(6), sliceMigration(8), holdReviewerMigration(9), trainMigration(10), holdSatisfiedMigration(11)];

/**
 * Routes for every dispatch step of `factoryWorkflows`, each match once. Every merge goes through the hold, so a held
 * PR never reaches the port's merge, whichever workflow lands it; an unbound store refuses the merge. A shepherd-pr
 * merge then waits for its repo's train, so a held PR never holds the train while it waits.
 */
export function factoryRoutesFor(deps: FactoryRouteDeps): FactoryRoutes {
  const holds = () => deps.store.get();
  const pause = deps.sleep ?? sleep;
  const freeze = deps.freeze ?? freezeStoreRef(deps.now);
  const guard = firstReason(freezeGuard({ freezes: () => freeze.get(), registrations: holds, now: deps.now }), releaseGuard(holds, deps.now));
  const satisfy = holdSatisfierFor(deps);
  const held = heldCheck(deps.port, holds, guard, satisfy);
  const train = deps.train ?? mergeTrainRef(deps.now);
  const timing = { sleep: pause, pollMs: deps.holdPollMs, now: deps.now };
  const land = landPrRoutes({ ...deps, port: holdingPort(deps.port, holds, guard, satisfy) }).map((route) =>
    route.match === "merge" ? waitWhileHeld(rideTrain(route, { train, port: deps.port, held, timing }), held, timing) : route,
  );
  const shepherdDeps = { port: deps.port, store: deps.store, now: deps.now ?? Date.now, sleep: pause, pollMs: deps.pollMs, agentChatBin: deps.agentChatBin ?? "agent-chat", cleanup: deps.cleanup };
  const review = deps.review && { ...deps.review, isFrozen: deps.isFrozen ?? (async (repo: string) => freeze.get().isFrozen(repo)) };
  const shepherd = shepherdRoutes(shepherdDeps, { review, park: deps.park, registry: deps.registry, mainRed: { ...deps.mainRed, freezes: () => freeze.get() } });
  const database: DatabaseTenant = { extraMigrations: SHEPHERD_MIGRATIONS, bind: (db) => bindAll(db, deps.store, freeze, train) };
  const services: ShepherdServices = { store: deps.store, port: deps.port, seats: deps.seats ?? (() => NO_SEATS), train };
  return Object.assign([...land, ...shepherd, trainLeaveRoute(train, shepherdDeps.now), redeployRoute(shepherdDeps.now, deps.redeploy)], { database, shepherd: services });
}

/** A hold's named reviewer is read through the review wiring's roster and reader; with no dispatch wired no hold is ever satisfied. */
function holdSatisfierFor(deps: FactoryRouteDeps): HoldSatisfier | undefined {
  const dispatch = deps.review?.dispatch;
  if (!deps.review || !dispatch) return undefined;
  return holdSatisfier({ store: () => deps.store.get(), roster: () => dispatch.roster(), reader: deps.review.reader });
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

/** One dispatch serves both halves, so the reader finds the reviewer on the roster that started it. No `review` key starts nothing. */
function configuredReview(shepherd: FactoryConfig["shepherd"], seats: () => SeatBook): FactoryRouteDeps["review"] {
  const { agentChatBin, review } = shepherd ?? {};
  if (!review || !agentChatBin) return undefined;
  const dispatch = agentChatReviewerDispatch({ agentChatBin, profile: review.profile, configDir: review.configDir, cwdFor: (repo) => checkoutPath(seats(), repo) });
  return { dispatch, reader: transcriptReviewerReader({ roster: dispatch.roster }), timeoutMs: review.verdictTimeoutMs, sessionStartTimeoutMs: review.sessionStartTimeoutMs };
}

/** Cleanup retires agents through the configured `agent-chat`, so no binary configured means no retire and no task close. */
function configuredCleanup(shepherd: FactoryConfig["shepherd"], env: NodeJS.ProcessEnv): CleanupPorts | undefined {
  const agentChatBin = shepherd?.agentChatBin;
  if (!agentChatBin) return undefined;
  return { agents: agentChatCleanupAgents(agentChatBin), tasks: activeWorkTasks({ origin: activeWorkOrigin(env) }) };
}

/** Fix tasks go over active-work's loopback rpc; a fixer needs the configured `agent-chat`. */
function configuredMainRed(shepherd: FactoryConfig["shepherd"], env: NodeJS.ProcessEnv): FactoryRouteDeps["mainRed"] {
  const agentChatBin = shepherd?.agentChatBin;
  return { tasks: activeWorkFixTasks({ origin: activeWorkOrigin(env) }), ...(agentChatBin && { fixers: agentChatFixers(agentChatBin, shepherd.fixer?.configDir) }) };
}

/** The bin this bundle was built as: dist/bin.js sits beside the bundled routes. */
const ownBin = (): string => fileURLToPath(new URL("./bin.js", import.meta.url));

/** The production route set: the post-merge chore and the reviewer come from the config file; the seat book is re-read per registration and per spawn. */
export function configuredRoutes(env: NodeJS.ProcessEnv, overrides: Partial<FactoryRouteDeps> = {}): FactoryRoutes {
  const { postMerge, shepherd } = loadConfig(configPath(env));
  const seats = overrides.seats ?? ((): SeatBook => loadSeatBook(loadConfig(configPath(env)).shepherd ?? {}));
  const review = configuredReview(shepherd, seats);
  const cleanup = configuredCleanup(shepherd, env);
  const mainRed = configuredMainRed(shepherd, env);
  const redeploy = systemDeployer({ bin: ownBin(), stateDir: factoryStateDir(env) });
  return factoryRoutesFor({ port: githubPort(ghCliWire()), store: shepherdStoreRef(), postMerge, review, agentChatBin: shepherd?.agentChatBin, cleanup, mainRed, redeploy, ...overrides, seats });
}

let cachedRoutes: FactoryRoutes | undefined;

/** The production routes, built on first call so a bad config file only fails commands that dispatch steps. */
export function factoryRoutes(): FactoryRoutes {
  cachedRoutes ??= configuredRoutes(process.env);
  return cachedRoutes;
}
