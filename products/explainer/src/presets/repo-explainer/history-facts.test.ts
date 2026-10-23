import { describe, expect, it } from "vitest";
import { historyFacts } from "./history-facts.js";
import { ExplainerFactSchema } from "./schemas.js";

const PIN = "2ddf3eb6c13d97b1d04a932c21de9a92029adaf9";

function report(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    snapshot: { id: 1, ref: "review-history", commitHash: PIN },
    windowDays: "lifetime",
    hotspots: [{ nodeId: "src/store.ts", churn: 420, complexity: 35, loc: 900, recency: 1, score: 1 }],
    busFactorRisks: [
      { nodeId: "src/store.ts", busFactor: 1, topAuthorShare: 0.931, churn: 420 },
      { nodeId: "src/http.ts", busFactor: 2, topAuthorShare: 0.5, churn: 80 },
    ],
    couplingClusters: [],
    ...overrides,
  });
}

describe("historyFacts", () => {
  it("yields a hotspot fact per hotspot and a silo fact per single-author file for a lifetime report at the pin", () => {
    const { facts, diagnostics } = historyFacts(report(), PIN);

    expect(diagnostics).toEqual([]);
    expect(facts.map((fact) => fact.id)).toEqual(["history/hotspot/src/store.ts", "history/silo/src/store.ts"]);
    for (const fact of facts) ExplainerFactSchema.parse(fact);
    expect(facts[0]).toMatchObject({ source: "history", kind: "hotspot", evidence: [{ path: "src/store.ts" }] });
    expect(facts[1]!.text).toContain("93%");
  });

  it("refuses a numeric window with W-HISTORY-PIN and no facts", () => {
    const { facts, diagnostics } = historyFacts(report({ windowDays: 30 }), PIN);

    expect(facts).toEqual([]);
    expect(diagnostics.map((finding) => finding.code)).toEqual(["W-HISTORY-PIN"]);
  });

  it("refuses a snapshot taken off the pin with W-HISTORY-PIN and no facts", () => {
    const offPin = report({ snapshot: { commitHash: "0000000000000000000000000000000000000001" } });

    const { facts, diagnostics } = historyFacts(offPin, PIN);

    expect(facts).toEqual([]);
    expect(diagnostics.map((finding) => finding.code)).toEqual(["W-HISTORY-PIN"]);
  });

  it("refuses when the review has no pin to compare against", () => {
    expect(historyFacts(report(), undefined).diagnostics.map((finding) => finding.code)).toEqual(["W-HISTORY-PIN"]);
  });

  it("returns a W-BAD-ROW diagnostic instead of throwing on malformed JSON", () => {
    const { facts, diagnostics } = historyFacts("[", PIN);

    expect(facts).toEqual([]);
    expect(diagnostics.map((finding) => finding.code)).toEqual(["W-BAD-ROW"]);
  });
});
