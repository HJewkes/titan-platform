import type { AgentRow } from "@titan-design/agent-dispatch";
import type { Registration, ShepherdStore, ShepherdStoreRef } from "./store.js";
import { isSeat } from "./wake-brief.js";
import { holdsLiveSession, latestRow, lineageSeat } from "./wake-roster.js";

/** The run's first registrant, and, when that was its own fixer, the successors the store records after it. */
interface RunLineage {
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

/**
 * The registering session hears the run's seat notices and digest while it is live (TP-3958); a retired one would drop
 * them. A fixer that registered its own PR exits when its turn ends, so the first session that spawned its lineage hears
 * them instead. No roster, or a lineage only the human spawned, names none. Undefined sends them to the repo's seat, as
 * before registrants were recorded.
 */
export function registrantSeat(lineage: RunLineage, roster: readonly AgentRow[] | undefined): string | undefined {
  const { registrant, successors } = lineage;
  if (!registrant || !roster) return undefined;
  if (!registrant.fixer) return holdsLiveSession(registrant.name, roster) ? registrant.name : undefined;
  return lineageSeat({ implementer: registrant.name, successors }, roster);
}

/**
 * A registrant that is no live seat leaves its digest to whoever spawned it (TP-4061): the first live seat up its
 * spawned-by chain, each hop read from the name's latest row. The chain stops at the human or a name already seen.
 */
export function spawnerSeat(lineage: RunLineage, roster: readonly AgentRow[] | undefined): string | undefined {
  const { registrant } = lineage;
  if (!registrant || registrant.fixer || !roster) return undefined;
  const seen = new Set([registrant.name]);
  let spawner = latestRow(registrant.name, roster)?.spawnedBy;
  while (isSeat(spawner) && !seen.has(spawner)) {
    if (holdsLiveSession(spawner, roster)) return spawner;
    seen.add(spawner);
    spawner = latestRow(spawner, roster)?.spawnedBy;
  }
  return undefined;
}
