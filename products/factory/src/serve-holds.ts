import { behindTrain, type HoldPredicate, type QueuedPredicate } from "./restart-drain.js";
import type { ShepherdServices } from "./shepherd/services.js";
import { spawnQueuePosition } from "./shepherd/spawn-gate.js";

/**
 * A run held and not yet satisfied cannot merge until release, nor can one waiting behind another run on its repo's train; a satisfied one may merge at any moment,
 * and an unreadable store throws, which counts it busy.
 */
export function heldRun(services: ShepherdServices | undefined): HoldPredicate | undefined {
  if (!services) return undefined;
  const waitsForTrain = behindTrain((run) => {
    const registration = services.store.get().byRun(run.id);
    return registration && services.train?.get().holder(registration.repo)?.runId;
  });
  return (run) => {
    const registration = services.store.get().byRun(run.id);
    return (registration !== undefined && registration.held && registration.holdSatisfied === null) || waitsForTrain(run);
  };
}

/** The gate drops a review's queue place when it admits it, before the spawn, so a run with a place has started no reviewer; an unreadable store throws, which counts it busy. */
export function gateQueuedRun(services: ShepherdServices | undefined): QueuedPredicate | undefined {
  if (!services) return undefined;
  return (run) => {
    const registration = services.store.get().byRun(run.id);
    return registration !== undefined && spawnQueuePosition(registration.repo, registration.pr) !== undefined;
  };
}
