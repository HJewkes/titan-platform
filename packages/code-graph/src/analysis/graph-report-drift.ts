import type {
  BusFactorChange,
  BusFactorRow,
  CouplingDelta,
  CouplingRow,
  HotspotDelta,
  HotspotRow,
  NewHotspot,
  ReportDrift,
} from "./graph-report-types.js";
import type { SnapshotRow } from "../types.js";

export interface ComputeDriftInput {
  baselineSnapshot: SnapshotRow;
  currentHotspots: readonly HotspotRow[];
  baselineHotspots: readonly HotspotRow[];
  /** Current churn × complexity for any nodeId. 0 when file is gone or no longer has churn/complexity. */
  currentHotspotScore: (nodeId: string) => number;
  /**
   * Baseline churn × complexity for a file that existed at baseline, or
   * `undefined` when the file is newborn (absent from the baseline snapshot).
   * Distinguishes a brand-new hotspot from an existing file that climbed in.
   */
  baselineHotspotScore?: (nodeId: string) => number | undefined;
  currentSilos: readonly BusFactorRow[];
  baselineSilos: readonly BusFactorRow[];
  /** Current bus_factor for any nodeId. undefined when file has no churn in window. */
  currentBusFactor: (nodeId: string) => number | undefined;
  currentCoupling: readonly CouplingRow[];
  baselineCoupling: readonly CouplingRow[];
}

export function computeReportDrift(input: ComputeDriftInput): ReportDrift {
  const hot = diffHotspots(
    input.currentHotspots,
    input.baselineHotspots,
    input.currentHotspotScore,
    input.baselineHotspotScore ?? (() => undefined),
  );
  const silos = diffSilos(
    input.currentSilos,
    input.baselineSilos,
    input.currentBusFactor,
  );
  const coupling = diffCoupling(input.currentCoupling, input.baselineCoupling);
  return {
    baselineSnapshot: input.baselineSnapshot,
    newHotspots: hot.added,
    resolvedHotspots: hot.resolved,
    displacedHotspots: hot.displaced,
    worsenedHotspots: hot.worsened,
    improvedHotspots: hot.improved,
    newSilos: silos.added,
    resolvedSilos: silos.resolved,
    displacedSilos: silos.displaced,
    newCoupling: coupling.added,
    intensifiedCoupling: coupling.intensified,
  };
}

function diffHotspots(
  cur: readonly HotspotRow[],
  base: readonly HotspotRow[],
  currentScore: (nodeId: string) => number,
  baselineScore: (nodeId: string) => number | undefined,
): {
  added: NewHotspot[];
  resolved: HotspotDelta[];
  displaced: HotspotDelta[];
  worsened: HotspotDelta[];
  improved: HotspotDelta[];
} {
  const baseById = new Map(base.map((r) => [r.nodeId, r] as const));
  const curById = new Map(cur.map((r) => [r.nodeId, r] as const));
  const added: NewHotspot[] = [];
  const resolved: HotspotDelta[] = [];
  const displaced: HotspotDelta[] = [];
  const worsened: HotspotDelta[] = [];
  const improved: HotspotDelta[] = [];
  for (const r of cur) {
    const b = baseById.get(r.nodeId);
    if (!b) {
      added.push({ ...r, before: baselineScore(r.nodeId) });
      continue;
    }
    const delta = r.score - b.score;
    if (delta > 0) worsened.push({ nodeId: r.nodeId, before: b.score, after: r.score, delta });
    else if (delta < 0) improved.push({ nodeId: r.nodeId, before: b.score, after: r.score, delta });
  }
  for (const b of base) {
    if (curById.has(b.nodeId)) continue;
    const after = currentScore(b.nodeId);
    const delta = after - b.score;
    const row: HotspotDelta = { nodeId: b.nodeId, before: b.score, after, delta };
    if (after < b.score) resolved.push(row);
    else displaced.push(row);
  }
  worsened.sort((a, b) => b.delta - a.delta);
  improved.sort((a, b) => a.delta - b.delta);
  resolved.sort((a, b) => a.delta - b.delta);
  displaced.sort((a, b) => b.before - a.before);
  return { added, resolved, displaced, worsened, improved };
}

function diffSilos(
  cur: readonly BusFactorRow[],
  base: readonly BusFactorRow[],
  currentBusFactor: (nodeId: string) => number | undefined,
): {
  added: BusFactorChange[];
  resolved: BusFactorChange[];
  displaced: BusFactorChange[];
} {
  const baseIds = new Set(base.map((r) => r.nodeId));
  const curIds = new Set(cur.map((r) => r.nodeId));
  const added: BusFactorChange[] = [];
  const resolved: BusFactorChange[] = [];
  const displaced: BusFactorChange[] = [];
  for (const r of cur) {
    if (!baseIds.has(r.nodeId)) added.push({ nodeId: r.nodeId, churn: r.churn });
  }
  for (const r of base) {
    if (curIds.has(r.nodeId)) continue;
    const bf = currentBusFactor(r.nodeId);
    if (bf === undefined || bf > 1) {
      resolved.push({ nodeId: r.nodeId, churn: r.churn });
    } else {
      displaced.push({ nodeId: r.nodeId, churn: r.churn });
    }
  }
  added.sort((a, b) => b.churn - a.churn);
  resolved.sort((a, b) => b.churn - a.churn);
  displaced.sort((a, b) => b.churn - a.churn);
  return { added, resolved, displaced };
}

function diffCoupling(
  cur: readonly CouplingRow[],
  base: readonly CouplingRow[],
): { added: CouplingRow[]; intensified: CouplingDelta[] } {
  const key = (r: { fileA: string; fileB: string }): string =>
    `${r.fileA}\t${r.fileB}`;
  const baseByKey = new Map(base.map((r) => [key(r), r] as const));
  const added: CouplingRow[] = [];
  const intensified: CouplingDelta[] = [];
  for (const r of cur) {
    const b = baseByKey.get(key(r));
    if (!b) added.push(r);
    else if (r.count > b.count) {
      intensified.push({
        fileA: r.fileA,
        fileB: r.fileB,
        before: b.count,
        after: r.count,
      });
    }
  }
  intensified.sort((a, b) => b.after - b.before - (a.after - a.before));
  return { added, intensified };
}
