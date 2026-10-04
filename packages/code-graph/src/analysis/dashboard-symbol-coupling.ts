import {
  computeSymbolConsumers,
  computeSymbolCoupling,
  type ReferenceEdgeLite,
} from "./symbol-coupling.js";

/**
 * Dashboard payload assembly for symbol-level coupling (C-60). Turns the raw
 * `references` edge set into two lean, capped slices the Coupling view renders,
 * so a god-file like `types.ts` decomposes into *which symbol goes where*
 * instead of one aggregate file node:
 *
 * - **Slice B — `symbolCoupling`**: symbol pairs consistently co-imported by the
 *   same files (structural, used-together coupling; drift-free).
 * - **Slice C — `symbolConsumers`**: per-file groups of exported symbols with
 *   the files that consume each — the literal "what IN this file is used where".
 *
 * Kept out of dashboard-payload.ts (at its LOC ceiling) so that file stays lean.
 */

/** One co-imported symbol pair, dashboard-lean (Slice B). */
export interface SymbolCouplingRow {
  aName: string;
  aFile: string;
  bName: string;
  bFile: string;
  coImports: number;
  crossFile: boolean;
}

/** One symbol and the files that consume it (Slice C). */
export interface SymbolConsumerRow {
  name: string;
  /** Up to CONSUMER_SAMPLE consuming file ids. */
  consumers: string[];
  /** Full distinct-consumer count (consumers may be truncated). */
  consumerCount: number;
}

/** A file's shared exports and where each goes (Slice C, grouped for the view). */
export interface SymbolConsumerGroup {
  fileId: string;
  symbols: SymbolConsumerRow[];
  /** Sum of consumer counts across kept symbols — the group's ordering weight. */
  totalConsumers: number;
}

export interface SymbolCouplingPayload {
  symbolCoupling: SymbolCouplingRow[];
  symbolConsumers: SymbolConsumerGroup[];
}

/** A symbol must be imported by at least this many files to count as shared. */
const MIN_SHARED_CONSUMERS = 2;
const MAX_PAIRS = 40;
const MAX_GROUPS = 15;
const MAX_SYMBOLS_PER_GROUP = 10;
const CONSUMER_SAMPLE = 12;

export function buildSymbolCouplingPayload(
  edges: readonly ReferenceEdgeLite[],
): SymbolCouplingPayload {
  return {
    symbolCoupling: buildCouplingRows(edges),
    symbolConsumers: buildConsumerGroups(edges),
  };
}

function buildCouplingRows(
  edges: readonly ReferenceEdgeLite[],
): SymbolCouplingRow[] {
  return computeSymbolCoupling(edges)
    .slice(0, MAX_PAIRS)
    .map((p) => ({
      aName: p.aName,
      aFile: p.aFile,
      bName: p.bName,
      bFile: p.bFile,
      coImports: p.coImports,
      crossFile: p.crossFile,
    }));
}

function buildConsumerGroups(
  edges: readonly ReferenceEdgeLite[],
): SymbolConsumerGroup[] {
  const byFile = new Map<string, SymbolConsumerRow[]>();
  for (const s of computeSymbolConsumers(edges)) {
    if (s.consumers.length < MIN_SHARED_CONSUMERS) continue;
    const bucket = byFile.get(s.fileId) ?? [];
    bucket.push({
      name: s.name,
      consumers: s.consumers.slice(0, CONSUMER_SAMPLE),
      consumerCount: s.consumers.length,
    });
    byFile.set(s.fileId, bucket);
  }
  return foldGroups(byFile);
}

function foldGroups(
  byFile: ReadonlyMap<string, SymbolConsumerRow[]>,
): SymbolConsumerGroup[] {
  const groups: SymbolConsumerGroup[] = [];
  for (const [fileId, symbols] of byFile) {
    const kept = symbols.slice(0, MAX_SYMBOLS_PER_GROUP);
    groups.push({
      fileId,
      symbols: kept,
      totalConsumers: kept.reduce((n, s) => n + s.consumerCount, 0),
    });
  }
  return groups
    .sort(
      (a, b) =>
        b.symbols.length - a.symbols.length ||
        b.totalConsumers - a.totalConsumers ||
        (a.fileId < b.fileId ? -1 : 1),
    )
    .slice(0, MAX_GROUPS);
}
