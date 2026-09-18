import { parseSymbolId } from "../extractors/ids.js";

/**
 * Symbol-level change coupling (C-60). Decomposes a god-file the file-level
 * coupling view rolls up as one blob (e.g. `types.ts`) into *which symbol* is
 * used where. Built on the C-53 `references` edge substrate: `src` is the
 * importing file, `dst` is the imported symbol node id (`<fileId>#<name>`).
 *
 * Two slices, both pure functions of the assembled reference edge set (a
 * whole-graph rollup like utilization/PageRank, sound under incremental reuse
 * since it reads the reassembled edges, not a per-file cache):
 *
 * - **Slice C — per-symbol consumers**: invert the edges by `dst`, giving the
 *   set of files that import each symbol. Directly answers "what IN this file is
 *   used where"; covers span-less types/consts that a git-hunk approach cannot.
 * - **Slice B — co-import coupling**: group edges by `src`, and every pair of
 *   symbols co-imported by the same file is a coupling pair. Two symbols that
 *   are always imported together travel together — structural (used-together),
 *   drift-free coupling, as opposed to the temporal (changed-together) git
 *   co-edit signal.
 */

/** The minimal shape of a `references` edge this module consumes. */
export interface ReferenceEdgeLite {
  /** Importing file id. */
  srcId: string;
  /** Imported symbol node id (`<fileId>#<name>`). */
  dstId: string;
}

/** One symbol's consumer set (Slice C). */
export interface SymbolConsumers {
  symbolId: string;
  /** Declaring file, parsed from the symbol id. */
  fileId: string;
  /** Export name. */
  name: string;
  /** Distinct importing file ids, sorted. */
  consumers: string[];
}

/** A pair of symbols co-imported by the same file (Slice B). */
export interface SymbolCouplingPair {
  aId: string;
  aFile: string;
  aName: string;
  bId: string;
  bFile: string;
  bName: string;
  /** Distinct files that import both symbols. */
  coImports: number;
  /** True when the two symbols are declared in different files. */
  crossFile: boolean;
}

export interface SymbolCouplingOptions {
  /** Skip pairs co-imported by fewer than this many files. Default 2. */
  minCoImports?: number;
  /**
   * Skip importing files that reference more than this many distinct symbols —
   * a wide barrel-style importer would otherwise explode into O(n²) noise
   * pairs, mirroring change-coupling's large-commit guard. Default 40.
   */
  largeImporterThreshold?: number;
}

const DEFAULT_MIN_CO_IMPORTS = 2;
const DEFAULT_LARGE_IMPORTER_THRESHOLD = 40;

/**
 * Group reference edges by imported symbol, yielding each symbol's distinct
 * consuming files (Slice C). Sorted by consumer count desc, then symbol id, so
 * the most broadly-depended-on exports lead.
 */
export function computeSymbolConsumers(
  edges: readonly ReferenceEdgeLite[],
): SymbolConsumers[] {
  const bySymbol = new Map<string, Set<string>>();
  for (const e of edges) {
    let set = bySymbol.get(e.dstId);
    if (!set) {
      set = new Set();
      bySymbol.set(e.dstId, set);
    }
    set.add(e.srcId);
  }
  const out: SymbolConsumers[] = [];
  for (const [id, consumers] of bySymbol) {
    const parsed = parseSymbolId(id);
    if (!parsed) continue;
    out.push({
      symbolId: id,
      fileId: parsed.fileId,
      name: parsed.name,
      consumers: [...consumers].sort(),
    });
  }
  return out.sort(compareConsumers);
}

function compareConsumers(a: SymbolConsumers, b: SymbolConsumers): number {
  if (b.consumers.length !== a.consumers.length) {
    return b.consumers.length - a.consumers.length;
  }
  return a.symbolId < b.symbolId ? -1 : a.symbolId > b.symbolId ? 1 : 0;
}

/**
 * Every pair of symbols co-imported by the same file becomes a coupling pair,
 * counted by how many distinct files co-import them (Slice B). Wide importers
 * are dropped to keep the pairing near-linear. Sorted by co-import count desc,
 * cross-file pairs preferred at a tie (they are the actionable ones — a
 * same-file pair is just cohesion within one module).
 */
export function computeSymbolCoupling(
  edges: readonly ReferenceEdgeLite[],
  options: SymbolCouplingOptions = {},
): SymbolCouplingPair[] {
  const minCoImports = options.minCoImports ?? DEFAULT_MIN_CO_IMPORTS;
  const largeThreshold =
    options.largeImporterThreshold ?? DEFAULT_LARGE_IMPORTER_THRESHOLD;
  const bySource = groupSymbolsBySource(edges);
  const counts = new Map<string, number>();
  for (const symbols of bySource.values()) {
    if (symbols.length < 2 || symbols.length > largeThreshold) continue;
    accumulateSymbolPairs(symbols, counts);
  }
  return finalizePairs(counts, minCoImports);
}

function groupSymbolsBySource(
  edges: readonly ReferenceEdgeLite[],
): Map<string, string[]> {
  const perSource = new Map<string, Set<string>>();
  for (const e of edges) {
    if (!parseSymbolId(e.dstId)) continue;
    let set = perSource.get(e.srcId);
    if (!set) {
      set = new Set();
      perSource.set(e.srcId, set);
    }
    set.add(e.dstId);
  }
  const out = new Map<string, string[]>();
  for (const [src, set] of perSource) out.set(src, [...set].sort());
  return out;
}

function accumulateSymbolPairs(
  symbols: readonly string[],
  counts: Map<string, number>,
): void {
  for (let i = 0; i < symbols.length; i++) {
    for (let j = i + 1; j < symbols.length; j++) {
      const key = `${symbols[i]!}\t${symbols[j]!}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
}

function finalizePairs(
  counts: ReadonlyMap<string, number>,
  minCoImports: number,
): SymbolCouplingPair[] {
  const out: SymbolCouplingPair[] = [];
  for (const [key, coImports] of counts) {
    if (coImports < minCoImports) continue;
    const [aId, bId] = key.split("\t") as [string, string];
    const a = parseSymbolId(aId)!;
    const b = parseSymbolId(bId)!;
    out.push({
      aId,
      aFile: a.fileId,
      aName: a.name,
      bId,
      bFile: b.fileId,
      bName: b.name,
      coImports,
      crossFile: a.fileId !== b.fileId,
    });
  }
  return out.sort(comparePairs);
}

function comparePairs(a: SymbolCouplingPair, b: SymbolCouplingPair): number {
  if (b.coImports !== a.coImports) return b.coImports - a.coImports;
  if (a.crossFile !== b.crossFile) return a.crossFile ? -1 : 1;
  if (a.aId !== b.aId) return a.aId < b.aId ? -1 : 1;
  return a.bId < b.bId ? -1 : a.bId > b.bId ? 1 : 0;
}
