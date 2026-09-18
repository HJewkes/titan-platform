import type { GraphMetric } from "../types.js";

/**
 * Coverage is a whole-suite DYNAMIC artifact — a function of *which tests ran*,
 * not of any file's bytes — so it must NOT ride the content-hash reuse gate. It
 * is emitted as a `coverage_pct` metric that is deliberately absent from every
 * *_METRIC_NAMES reuse set, so an incremental index never carries it forward: a
 * later index produces a snapshot with NO coverage until re-ingested. That is the
 * overlay semantics — coverage is attached to the snapshot it was measured
 * against and never inferred for another.
 */
export const COVERAGE_METRIC_NAME = "coverage_pct";

/** Minimal Istanbul `coverage-final.json` shape we read (function-level). */
interface IstanbulFn {
  loc: { start: { line: number }; end: { line: number } };
}
interface IstanbulFileCoverage {
  fnMap: Record<string, IstanbulFn>;
  /** Per-function hit counts, keyed to fnMap ids. */
  f: Record<string, number>;
}
export type IstanbulCoverage = Record<string, IstanbulFileCoverage>;

/** A symbol node's 1-based line span, for range-containment attribution. */
export interface SymbolSpan {
  id: string;
  startLine: number;
  endLine: number;
}

function isFileCoverage(v: unknown): v is IstanbulFileCoverage {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as IstanbulFileCoverage).fnMap === "object" &&
    typeof (v as IstanbulFileCoverage).f === "object"
  );
}

/** The smallest-span symbol whose 1-based range contains `line`, or null. */
function innermostContaining(symbols: readonly SymbolSpan[], line: number): SymbolSpan | null {
  let best: SymbolSpan | null = null;
  for (const s of symbols) {
    if (s.startLine <= line && line <= s.endLine) {
      if (!best || s.endLine - s.startLine < best.endLine - best.startLine) best = s;
    }
  }
  return best;
}

/**
 * Attribute an Istanbul coverage report to graph nodes as `coverage_pct` metrics:
 * one per covered FILE (covered functions / total functions), and one per SYMBOL
 * a covered function maps into by RANGE containment (symbol spans) — matching
 * by range, not name, so anonymous/mangled Istanbul function names are handled.
 * A symbol spanning several functions (a class) reports its methods' coverage
 * ratio. Files Istanbul reports but the graph doesn't know are skipped.
 */
export function attributeCoverage(
  coverage: IstanbulCoverage,
  fileIdOf: (absPath: string) => string | null,
  symbolsByFile: ReadonlyMap<string, readonly SymbolSpan[]>,
): GraphMetric[] {
  const out: GraphMetric[] = [];
  for (const [absPath, fc] of Object.entries(coverage)) {
    if (!isFileCoverage(fc)) continue;
    const fileId = fileIdOf(absPath);
    if (!fileId) continue;
    const fnIds = Object.keys(fc.fnMap);
    if (fnIds.length === 0) continue;

    const covered = fnIds.filter((k) => (fc.f[k] ?? 0) > 0).length;
    out.push(pctMetric(fileId, covered, fnIds.length));
    out.push(...symbolCoverage(fc, fnIds, symbolsByFile.get(fileId) ?? []));
  }
  return out;
}

function symbolCoverage(fc: IstanbulFileCoverage, fnIds: readonly string[], symbols: readonly SymbolSpan[]): GraphMetric[] {
  const perSymbol = new Map<string, { hit: number; total: number }>();
  for (const k of fnIds) {
    const sym = innermostContaining(symbols, fc.fnMap[k]!.loc.start.line);
    if (!sym) continue;
    const acc = perSymbol.get(sym.id) ?? { hit: 0, total: 0 };
    acc.total++;
    if ((fc.f[k] ?? 0) > 0) acc.hit++;
    perSymbol.set(sym.id, acc);
  }
  return [...perSymbol].map(([id, { hit, total }]) => pctMetric(id, hit, total));
}

function pctMetric(nodeId: string, covered: number, total: number): GraphMetric {
  return {
    nodeId,
    name: COVERAGE_METRIC_NAME,
    value: Math.round((100 * covered) / total),
    unit: "percent",
  };
}
