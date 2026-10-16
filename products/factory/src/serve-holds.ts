import { behindTrain, type HoldPredicate } from "./restart-drain.js";
import type { ShepherdServices } from "./shepherd/services.js";

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
