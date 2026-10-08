import type { AgentRow } from "@titan-design/agent-dispatch";
import { isSeat } from "./wake-brief.js";

/** The run's registered implementer and the successors the store's lineage records, earliest first. */
export interface Lineage {
  implementer: string;
  successors: readonly string[];
}

function successorIndex(implementer: string, name: string): number | undefined {
  const rest = name.startsWith(`${implementer}-s`) ? name.slice(implementer.length + 2) : "";
  return /^[1-9]\d*$/.test(rest) ? Number(rest) : undefined;
}

/** The implementer, then its successors: the lineage's first, then `<implementer>-s<k>` names by `k`. */
function chain(lineage: Lineage, roster: readonly AgentRow[]): string[] {
  const indexed = roster.flatMap((row) => {
    const k = successorIndex(lineage.implementer, row.name);
    return k === undefined ? [] : [{ name: row.name, k }];
  });
  return [...new Set([lineage.implementer, ...lineage.successors, ...indexed.sort((a, b) => a.k - b.k).map((row) => row.name)])];
}

/** A name can span several sessions; the latest generation is the one that holds it. */
export function latestRow(name: string, roster: readonly AgentRow[]): AgentRow | undefined {
  return roster.filter((row) => row.name === name).reduce<AgentRow | undefined>((best, row) => (best === undefined || row.generation >= best.generation ? row : best), undefined);
}

/** The earliest spawner in the lineage that is a session; a successor's own spawner is the human, which names no seat. */
export function lineageSeat(lineage: Lineage, roster: readonly AgentRow[]): string | undefined {
  return chain(lineage, roster)
    .flatMap((name) => roster.filter((row) => row.name === name).map((row) => row.spawnedBy))
    .find(isSeat);
}

export function newestAgent(lineage: Lineage, roster: readonly AgentRow[]): AgentRow | undefined {
  return chain(lineage, roster)
    .reverse()
    .map((name) => latestRow(name, roster))
    .find((row) => row !== undefined);
}

export function successorName(lineage: Lineage, roster: readonly AgentRow[]): string {
  const taken = [...roster.map((row) => row.name), ...lineage.successors];
  const highest = Math.max(0, ...taken.map((name) => successorIndex(lineage.implementer, name) ?? 0));
  return `${lineage.implementer}-s${highest + 1}`;
}
