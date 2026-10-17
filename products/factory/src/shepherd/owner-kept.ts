import type { ShepherdServices } from "./services.js";
import type { Registration } from "./store.js";

/**
 * Only an owner hold keeps its gate. Any other hold is read, and satisfied, only on the merge path, which a run parked at
 * a gate never reaches, so its gate is superseded and the merge step waits on the hold instead.
 */
export const keptForOwner = (registration: Registration | undefined): boolean => registration === undefined || registration.ownerHold !== null;

/**
 * The services with every owner-held run unregistered, so the base sweep, which leaves a run it finds no registration
 * for, leaves an owner hold's gate with the owner as the transient sweep does.
 */
export function withoutOwnerHeld(services: ShepherdServices): ShepherdServices {
  const store = services.store.get();
  const visible = Object.create(store, { byRun: { value: (runId: string) => (keptForOwner(store.byRun(runId)) ? undefined : store.byRun(runId)) } });
  return { ...services, store: { ...services.store, get: () => visible } };
}
