import { ghCliWire, githubPort, type GitHubPort } from "@titan-design/github";
import { configPath, loadConfig } from "./config.js";
import type { WorkflowDefinition } from "./definition.js";
import type { DatabaseTenant, FactoryRoutes } from "./host.js";
import { heldCheck, holdingPort, waitWhileHeld } from "./shepherd/hold.js";
import { shepherdPrWorkflow, shepherdRoutes } from "./shepherd/pr.js";
import { shepherdMigration, shepherdStoreRef, type ShepherdStoreRef } from "./shepherd/store.js";
import { sleep } from "./workflows/land.js";
import { landPrRoutes, landPrWorkflow, type LandPrDeps } from "./workflows/land-pr.js";

/** Every workflow the CLI hosts. Pilots register here as their slices land (doc-change in S3). */
export const factoryWorkflows: readonly WorkflowDefinition[] = [landPrWorkflow(), shepherdPrWorkflow()];

export interface FactoryRouteDeps extends LandPrDeps {
  port: GitHubPort;
  store: ShepherdStoreRef;
  holdPollMs?: number;
  agentChatBin?: string;
}

/**
 * Routes for every dispatch step of `factoryWorkflows`, each match once. Every merge goes through the hold, so a held
 * PR never reaches the port's merge, whichever workflow lands it; an unbound store refuses the merge.
 */
export function factoryRoutesFor(deps: FactoryRouteDeps): FactoryRoutes {
  const holds = () => deps.store.get();
  const pause = deps.sleep ?? sleep;
  const held = heldCheck(deps.port, holds);
  const land = landPrRoutes({ ...deps, port: holdingPort(deps.port, holds) }).map((route) =>
    route.match === "merge" ? waitWhileHeld(route, held, { sleep: pause, pollMs: deps.holdPollMs }) : route,
  );
  const shepherd = shepherdRoutes({ port: deps.port, store: deps.store, now: deps.now ?? Date.now, sleep: pause, pollMs: deps.pollMs, agentChatBin: deps.agentChatBin ?? "agent-chat" });
  const database: DatabaseTenant = { extraMigrations: [shepherdMigration(4)], bind: (db) => deps.store.bind(db) };
  return Object.assign([...land, ...shepherd], { database });
}

/** The production route set: the post-merge chore comes from the config file, the one place the CLI reads it. */
export function configuredRoutes(env: NodeJS.ProcessEnv, overrides: Partial<FactoryRouteDeps> = {}): FactoryRoutes {
  const { postMerge } = loadConfig(configPath(env));
  return factoryRoutesFor({ port: githubPort(ghCliWire()), store: shepherdStoreRef(), postMerge, ...overrides });
}

let cachedRoutes: FactoryRoutes | undefined;

/** The production routes, built on first call so a bad config file only fails commands that dispatch steps. */
export function factoryRoutes(): FactoryRoutes {
  cachedRoutes ??= configuredRoutes(process.env);
  return cachedRoutes;
}
