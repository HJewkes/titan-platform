import { behindTrain, type HoldPredicate, type QueuedPredicate } from "./restart-drain.js";
import { holdBarsMerge } from "./shepherd/lan-gates.js";
import { spawnQueuePosition } from "./shepherd/review-queue.js";
import type { ShepherdServices } from "./shepherd/services.js";
import { lastCiHead } from "./shepherd/stats.js";

/**
 * A run whose hold bars its merge cannot merge until release, nor can one waiting behind another run on its repo's train; a satisfied one, or one
 * whose lan-gates are green at the head its merge step is at, may merge at any moment, and an unreadable store throws, which counts it busy.
 */
export function heldRun(services: ShepherdServices | undefined): HoldPredicate | undefined {
  if (!services) return undefined;
  const waitsForTrain = behindTrain((run) => {
    const registration = services.store.get().byRun(run.id);
    return registration && services.train?.get().holder(registration.repo)?.runId;
  });
  return (run) => {
    const store = services.store.get();
    return holdBarsMerge(store, store.byRun(run.id), lastCiHead(run)) || waitsForTrain(run);
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
