import type { Logger, StartDaemonOptions } from "@titan-design/daemon";
import { mountConsoleAction } from "./console-action-rpc.js";
import { mountGateAnswer, type ConsoleAnswersOptions } from "./gate-answer-rpc.js";
import type { FactoryHost } from "./host.js";
import type { OwnerKeys } from "./owner-keys.js";
import { mountResolveProof } from "./resolve-proof.js";
import type { ShepherdServices } from "./shepherd/services.js";

type App = Parameters<NonNullable<StartDaemonOptions["mountRoutes"]>>[0];

export interface ConsoleAnswersServeOptions {
  /** Mounts the console Ship route over this rounds dir; absent means the route is not mounted and answers 404. */
  consoleAnswers?: ConsoleAnswersOptions;
}

interface ServeRoutesDeps extends ConsoleAnswersServeOptions {
  host: FactoryHost;
  keys: OwnerKeys;
  aud: string;
  now: () => number;
  routes: { shepherd?: ShepherdServices };
  stateDir: string;
  log: Logger;
}

/** The routes serve mounts beside the registry's; none of them is a command or an MCP tool. */
export function mountServeRoutes(app: App, { routes, consoleAnswers, stateDir, ...deps }: ServeRoutesDeps): void {
  const { shepherd } = routes;
  mountResolveProof(app, { ...deps, port: shepherd?.port, store: shepherd?.store });
  if (consoleAnswers) mountGateAnswer(app, { host: deps.host, port: shepherd?.port, roundsDir: consoleAnswers.roundsDir, stateDir, now: deps.now, log: deps.log });
  if (consoleAnswers?.actionsDir !== undefined) mountConsoleAction(app, { host: deps.host, port: shepherd?.port, actionsDir: consoleAnswers.actionsDir, log: deps.log });
}
