import type { AgentRow } from "@titan-design/agent-dispatch";
import type { Registration, ShepherdStore, ShepherdStoreRef } from "./store.js";
import { lineageSeat } from "./wake-roster.js";

/** The run's first registrant, and, when that was its own fixer, the successors the store records after it. */
export interface RunLineage {
  registrant: Registration["registrant"];
  successors: readonly string[];
}

/** Successors are read only for a fixer's registration, the one case whose seat is found through them. */
export function runLineage(store: ShepherdStore, { registrant, runId }: Registration): RunLineage {
  const successors = registrant?.fixer ? store.authorsOf(runId).filter((author) => author.role === "successor").map((author) => author.name) : [];
  return { registrant, successors };
}

/** The lineage of the run registered on `repo#pr`; an unbound store throws, which a notice reads as no lineage. */
export function storedLineage(ref: ShepherdStoreRef, target: { repo: string; pr: number }): RunLineage | undefined {
  const store = ref.get();
  const registration = store.byPr(target.repo, target.pr);
  return registration && runLineage(store, registration);
}

export const fixerRegistered = (lineage: RunLineage): boolean => lineage.registrant?.fixer === true;

/**
 * The registering session hears the run's seat notices and digest. A fixer that registered its own PR exits when its turn
 * ends, so the first session that spawned its lineage hears them instead; no roster, or a lineage only the human spawned,
 * names none. Undefined sends them to the repo's seat, as before registrants were recorded.
 */
export function registrantSeat(lineage: RunLineage, roster: readonly AgentRow[] | undefined): string | undefined {
  const { registrant, successors } = lineage;
  if (!registrant) return undefined;
  if (!registrant.fixer) return registrant.name;
  return roster && lineageSeat({ implementer: registrant.name, successors }, roster);
}
