import { describe, it, expect } from "vitest";
import { computeReportDrift } from "./graph-report-drift.js";
import type {
  BusFactorRow,
  CouplingRow,
  HotspotRow,
} from "./graph-report-types.js";

const SNAP = {
  id: 99,
  ref: "baseline",
  commitHash: null,
  takenAt: new Date(0).toISOString(),
  indexVersion: "0.1.0",
  attrs: {},
};

function hot(id: string, score: number): HotspotRow {
  return { nodeId: id, churn: 0, complexity: 0, recency: 1, score };
}

function silo(id: string, churn = 0): BusFactorRow {
  return { nodeId: id, busFactor: 1, topAuthorShare: 1, churn };
}

function pair(a: string, b: string, count: number): CouplingRow {
  return { fileA: a, fileB: b, count };
}

const NO_HOTSPOT_SCORES = (): number => 0;
const NO_BUS_FACTOR = (): number | undefined => undefined;

describe("computeReportDrift — hotspots", () => {
  it("classifies entries by presence/absence/score-delta", () => {
    const drift = computeReportDrift({
      baselineSnapshot: SNAP,
      currentHotspots: [hot("a", 100), hot("b", 80), hot("d", 50)],
      baselineHotspots: [hot("a", 90), hot("b", 100), hot("c", 60)],
      currentHotspotScore: (id) => (id === "c" ? 10 : 0),
      currentSilos: [],
      baselineSilos: [],
      currentBusFactor: NO_BUS_FACTOR,
      currentCoupling: [],
      baselineCoupling: [],
    });
    expect(drift.newHotspots.map((r) => r.nodeId)).toEqual(["d"]);
    expect(drift.resolvedHotspots.map((r) => r.nodeId)).toEqual(["c"]);
    expect(drift.resolvedHotspots[0]!).toMatchObject({ before: 60, after: 10, delta: -50 });
    expect(drift.displacedHotspots).toEqual([]);
    expect(drift.worsenedHotspots.map((d) => d.nodeId)).toEqual(["a"]);
    expect(drift.improvedHotspots.map((d) => d.nodeId)).toEqual(["b"]);
    expect(drift.worsenedHotspots[0]!.delta).toBe(10);
    expect(drift.improvedHotspots[0]!.delta).toBe(-20);
  });

  it("classifies displaced hotspots (fell off top-N without improving)", () => {
    // c was in baseline at 60; it's no longer in top-N, but its current score
    // is HIGHER (80) — newer/worse hotspots crowded it out. Not "resolved".
    const drift = computeReportDrift({
      baselineSnapshot: SNAP,
      currentHotspots: [hot("a", 200), hot("b", 150), hot("d", 90)],
      baselineHotspots: [hot("a", 100), hot("c", 60)],
      currentHotspotScore: (id) => (id === "c" ? 80 : 0),
      currentSilos: [],
      baselineSilos: [],
      currentBusFactor: NO_BUS_FACTOR,
      currentCoupling: [],
      baselineCoupling: [],
    });
    expect(drift.resolvedHotspots).toEqual([]);
    expect(drift.displacedHotspots.map((r) => r.nodeId)).toEqual(["c"]);
    expect(drift.displacedHotspots[0]!).toMatchObject({ before: 60, after: 80, delta: 20 });
  });

  it("treats a baseline hotspot with score equal to current as displaced, not resolved", () => {
    const drift = computeReportDrift({
      baselineSnapshot: SNAP,
      currentHotspots: [hot("a", 200)],
      baselineHotspots: [hot("c", 50)],
      currentHotspotScore: (id) => (id === "c" ? 50 : 0),
      currentSilos: [],
      baselineSilos: [],
      currentBusFactor: NO_BUS_FACTOR,
      currentCoupling: [],
      baselineCoupling: [],
    });
    expect(drift.resolvedHotspots).toEqual([]);
    expect(drift.displacedHotspots.map((r) => r.nodeId)).toEqual(["c"]);
  });

  it("tags a new hotspot with its baseline score (risen) vs undefined (newborn)", () => {
    // "risen" existed at baseline (score 40, below top-N) and climbed into the
    // list; "newborn" is absent from the baseline snapshot entirely.
    const drift = computeReportDrift({
      baselineSnapshot: SNAP,
      currentHotspots: [hot("risen", 120), hot("newborn", 90)],
      baselineHotspots: [hot("a", 200)],
      currentHotspotScore: NO_HOTSPOT_SCORES,
      baselineHotspotScore: (id) => (id === "risen" ? 40 : undefined),
      currentSilos: [],
      baselineSilos: [],
      currentBusFactor: NO_BUS_FACTOR,
      currentCoupling: [],
      baselineCoupling: [],
    });
    const byId = new Map(drift.newHotspots.map((h) => [h.nodeId, h] as const));
    expect(byId.get("risen")!.before).toBe(40);
    expect(byId.get("newborn")!.before).toBeUndefined();
  });

  it("leaves new-hotspot `before` undefined when no baselineHotspotScore is supplied", () => {
    const drift = computeReportDrift({
      baselineSnapshot: SNAP,
      currentHotspots: [hot("d", 50)],
      baselineHotspots: [hot("a", 90)],
      currentHotspotScore: NO_HOTSPOT_SCORES,
      currentSilos: [],
      baselineSilos: [],
      currentBusFactor: NO_BUS_FACTOR,
      currentCoupling: [],
      baselineCoupling: [],
    });
    expect(drift.newHotspots[0]!.before).toBeUndefined();
  });

  it("sorts worsened by absolute delta desc", () => {
    const drift = computeReportDrift({
      baselineSnapshot: SNAP,
      currentHotspots: [hot("a", 200), hot("b", 110)],
      baselineHotspots: [hot("a", 100), hot("b", 100)],
      currentHotspotScore: NO_HOTSPOT_SCORES,
      currentSilos: [],
      baselineSilos: [],
      currentBusFactor: NO_BUS_FACTOR,
      currentCoupling: [],
      baselineCoupling: [],
    });
    expect(drift.worsenedHotspots.map((d) => d.nodeId)).toEqual(["a", "b"]);
  });
});

describe("computeReportDrift — silos", () => {
  it("flags newly-emerged silos and truly-resolved silos (bus_factor cleared)", () => {
    const drift = computeReportDrift({
      baselineSnapshot: SNAP,
      currentHotspots: [],
      baselineHotspots: [],
      currentHotspotScore: NO_HOTSPOT_SCORES,
      currentSilos: [silo("a", 50), silo("b", 200)],
      baselineSilos: [silo("a", 10), silo("c", 80)],
      // c picked up a second author → bus_factor=2.
      currentBusFactor: (id) => (id === "c" ? 2 : undefined),
      currentCoupling: [],
      baselineCoupling: [],
    });
    expect(drift.newSilos.map((s) => s.nodeId)).toEqual(["b"]);
    expect(drift.resolvedSilos.map((s) => s.nodeId)).toEqual(["c"]);
    expect(drift.displacedSilos).toEqual([]);
  });

  it("classifies a silo whose churn fell off top-N as displaced, not resolved", () => {
    // c is still bus_factor=1 — just dropped below the churn cutoff.
    const drift = computeReportDrift({
      baselineSnapshot: SNAP,
      currentHotspots: [],
      baselineHotspots: [],
      currentHotspotScore: NO_HOTSPOT_SCORES,
      currentSilos: [silo("a", 50)],
      baselineSilos: [silo("a", 10), silo("c", 80)],
      currentBusFactor: (id) => (id === "c" ? 1 : undefined),
      currentCoupling: [],
      baselineCoupling: [],
    });
    expect(drift.resolvedSilos).toEqual([]);
    expect(drift.displacedSilos.map((s) => s.nodeId)).toEqual(["c"]);
  });

  it("treats a silo that has no churn in window as resolved", () => {
    // c had churn in baseline; current bus_factor lookup returns undefined
    // (no churn ⇒ no bus_factor metric emitted) — effectively resolved.
    const drift = computeReportDrift({
      baselineSnapshot: SNAP,
      currentHotspots: [],
      baselineHotspots: [],
      currentHotspotScore: NO_HOTSPOT_SCORES,
      currentSilos: [],
      baselineSilos: [silo("c", 80)],
      currentBusFactor: NO_BUS_FACTOR,
      currentCoupling: [],
      baselineCoupling: [],
    });
    expect(drift.resolvedSilos.map((s) => s.nodeId)).toEqual(["c"]);
    expect(drift.displacedSilos).toEqual([]);
  });
});

describe("computeReportDrift — coupling", () => {
  it("flags new pairs and intensified counts", () => {
    const drift = computeReportDrift({
      baselineSnapshot: SNAP,
      currentHotspots: [],
      baselineHotspots: [],
      currentHotspotScore: NO_HOTSPOT_SCORES,
      currentSilos: [],
      baselineSilos: [],
      currentBusFactor: NO_BUS_FACTOR,
      currentCoupling: [pair("a", "b", 5), pair("c", "d", 3), pair("e", "f", 2)],
      baselineCoupling: [pair("a", "b", 2), pair("c", "d", 3)],
    });
    expect(drift.newCoupling.map((p) => `${p.fileA}|${p.fileB}`)).toEqual(["e|f"]);
    expect(drift.intensifiedCoupling.map((p) => `${p.fileA}|${p.fileB}`)).toEqual(
      ["a|b"],
    );
    expect(drift.intensifiedCoupling[0]!.before).toBe(2);
    expect(drift.intensifiedCoupling[0]!.after).toBe(5);
  });
});
