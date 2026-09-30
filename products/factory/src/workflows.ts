import { ghCliWire, githubPort, type GitHubPort } from "@titan-design/github";
import type { Db } from "@titan-design/store-sqlite";
import { configPath, loadConfig, type FactoryConfig } from "./config.js";
import type { WorkflowDefinition } from "./definition.js";
import type { DatabaseTenant, FactoryRoutes } from "./host.js";
import type { CleanupPorts } from "./shepherd/cleanup.js";
import { activeWorkOrigin, activeWorkTasks, agentChatCleanupAgents } from "./shepherd/cleanup-ports.js";
import type { ShepherdServices } from "./shepherd/commands.js";
import { freezeGuard, freezeMigration, freezeStoreRef, type FreezeStoreRef } from "./shepherd/freeze.js";
import { heldCheck, holdingPort, waitWhileHeld } from "./shepherd/hold.js";
import type { IsFrozen } from "./shepherd/merge-facts.js";
import type { ParkPort } from "./shepherd/park.js";
import { shepherdPrWorkflow, shepherdRoutes } from "./shepherd/pr.js";
import type { ReviewWiring } from "./shepherd/review.js";
import { agentChatReviewerDispatch } from "./shepherd/reviewer-dispatch.js";
import { transcriptReviewerReader } from "./shepherd/reviewer-reader.js";
import { loadSeatBook, lookupSeat, type SeatBook } from "./shepherd/seats.js";
import { lineageMigration, shepherdMigration, shepherdStoreRef, type ShepherdStoreRef } from "./shepherd/store.js";
import { sleep } from "./workflows/land.js";
import { landPrRoutes, landPrWorkflow, type LandPrDeps } from "./workflows/land-pr.js";

/** Every workflow the CLI hosts. Pilots register here as their slices land (doc-change in S3). */
export const factoryWorkflows: readonly WorkflowDefinition[] = [landPrWorkflow(), shepherdPrWorkflow()];

export interface FactoryRouteDeps extends LandPrDeps {
  port: GitHubPort;
  store: ShepherdStoreRef;
  freeze?: FreezeStoreRef;
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
}

const NO_SEATS: SeatBook = { seats: [], denied: [] };

/**
 * Routes for every dispatch step of `factoryWorkflows`, each match once. Every merge goes through the hold, so a held
 * PR never reaches the port's merge, whichever workflow lands it; an unbound store refuses the merge.
 */
export function factoryRoutesFor(deps: FactoryRouteDeps): FactoryRoutes {
  const holds = () => deps.store.get();
  const pause = deps.sleep ?? sleep;
  const freeze = deps.freeze ?? freezeStoreRef(deps.now);
  const guard = freezeGuard({ freezes: () => freeze.get(), registrations: holds, now: deps.now });
  const held = heldCheck(deps.port, holds, guard);
  const land = landPrRoutes({ ...deps, port: holdingPort(deps.port, holds, guard) }).map((route) =>
    route.match === "merge" ? waitWhileHeld(route, held, { sleep: pause, pollMs: deps.holdPollMs }) : route,
  );
  const shepherdDeps = { port: deps.port, store: deps.store, now: deps.now ?? Date.now, sleep: pause, pollMs: deps.pollMs, agentChatBin: deps.agentChatBin ?? "agent-chat", cleanup: deps.cleanup };
  const review = deps.review && { ...deps.review, isFrozen: deps.isFrozen ?? (async (repo: string) => freeze.get().isFrozen(repo)) };
  const shepherd = shepherdRoutes(shepherdDeps, { review, park: deps.park });
  const database: DatabaseTenant = { extraMigrations: [shepherdMigration(4), lineageMigration(5), freezeMigration(6)], bind: (db) => bindAll(db, deps.store, freeze) };
  const services: ShepherdServices = { store: deps.store, port: deps.port, seats: deps.seats ?? (() => NO_SEATS) };
  return Object.assign([...land, ...shepherd], { database, shepherd: services });
}

function bindAll(db: Db, ...refs: { bind(db: Db): () => void }[]): () => void {
  const unbinds = refs.map((ref) => ref.bind(db));
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

/** The production route set: the post-merge chore and the reviewer come from the config file; the seat book is re-read per registration and per spawn. */
export function configuredRoutes(env: NodeJS.ProcessEnv, overrides: Partial<FactoryRouteDeps> = {}): FactoryRoutes {
  const { postMerge, shepherd } = loadConfig(configPath(env));
  const seats = overrides.seats ?? ((): SeatBook => loadSeatBook(loadConfig(configPath(env)).shepherd ?? {}));
  const review = configuredReview(shepherd, seats);
  const cleanup = configuredCleanup(shepherd, env);
  return factoryRoutesFor({ port: githubPort(ghCliWire()), store: shepherdStoreRef(), postMerge, review, cleanup, ...overrides, seats });
}

let cachedRoutes: FactoryRoutes | undefined;

/** The production routes, built on first call so a bad config file only fails commands that dispatch steps. */
export function factoryRoutes(): FactoryRoutes {
  cachedRoutes ??= configuredRoutes(process.env);
  return cachedRoutes;
}
