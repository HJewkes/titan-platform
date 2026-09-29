import { ghCliWire, githubPort, type GitHubPort } from "@titan-design/github";
import type { WorkflowDefinition } from "./definition.js";
import type { DatabaseTenant, FactoryRoutes } from "./host.js";
import { holdingPort, waitWhileHeld } from "./shepherd/hold.js";
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
 * PR never reaches the port's merge, whichever workflow lands it.
 */
export function factoryRoutesFor(deps: FactoryRouteDeps): FactoryRoutes {
  const holds = () => deps.store.get();
  const pause = deps.sleep ?? sleep;
  const land = landPrRoutes({ ...deps, port: holdingPort(deps.port, holds) }).map((route) =>
    route.match === "merge" ? waitWhileHeld(route, holds, { sleep: pause, pollMs: deps.holdPollMs }) : route,
  );
  const shepherd = shepherdRoutes({ port: deps.port, store: deps.store, now: deps.now ?? Date.now, sleep: pause, pollMs: deps.pollMs, agentChatBin: deps.agentChatBin ?? "agent-chat" });
  const database: DatabaseTenant = { extraMigrations: [shepherdMigration(4)], bind: (db) => deps.store.bind(db) };
  return Object.assign([...land, ...shepherd], { database });
}

export const factoryRoutes: FactoryRoutes = factoryRoutesFor({ port: githubPort(ghCliWire()), store: shepherdStoreRef() });
