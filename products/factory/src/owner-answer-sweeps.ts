import type { Logger } from "@titan-design/daemon";
import type { FactoryHost } from "./host.js";
import { startStandingAnswerSweep } from "./owner-ops/standing-answers.js";
import type { ConsoleAnswersServeOptions } from "./serve-routes.js";
import type { AutoByRecConfig } from "./shepherd/by-rec-config.js";
import { byRecLogPath } from "./shepherd/by-rec-log.js";
import { startByRecSweep } from "./shepherd/by-rec-sweep.js";
import { startRoundShipSweep } from "./shepherd/round-ship-sweep.js";
import type { ShepherdServices } from "./shepherd/services.js";
import type { Sweep } from "./sweep.js";

interface OwnerAnswerSweepOptions extends ConsoleAnswersServeOptions {
  now?: () => number;
  /** `shepherd.autoByRec`, read at each tick so a mode change applies without a restart. */
  autoByRec: () => AutoByRecConfig | undefined;
}

/** The sweeps that settle an owner gate the owner did not answer live: a console Ship, a standing answer, and auto-by-rec (TP-6772). */
export function startOwnerAnswerSweeps(host: FactoryHost, services: ShepherdServices | undefined, options: OwnerAnswerSweepOptions, stateDir: string, log: Logger): (Sweep | undefined)[] {
  const { consoleAnswers, now } = options;
  return [
    startRoundShipSweep(host, services, consoleAnswers?.roundsDir, log, now),
    startStandingAnswerSweep(host, services, { actionsDir: consoleAnswers?.actionsDir, stateDir, now, tell: consoleAnswers?.tellOwner }, log),
    services && startByRecSweep(host, services, { config: options.autoByRec, logPath: byRecLogPath(stateDir), now: now ?? Date.now }, log),
  ];
}
