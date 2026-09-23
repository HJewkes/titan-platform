import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { costReport } from "./cost-report.js";
import { SCENARIO_WINDOW, createFixtureGraph, seedCostScenario, type FixtureGraph } from "./fixture.js";
import { LIST_PRICE_CAVEAT, renderCostReportText } from "./render-text.js";

let fixture: FixtureGraph;

beforeEach(() => {
  fixture = createFixtureGraph();
  seedCostScenario(fixture);
});
afterEach(() => fixture.close());

const SECTIONS = [
  "Cost report, 2026-09-20 to 2026-09-21",
  "By token class",
  "By account",
  "By model",
  "By class",
  "By role",
  "By initiative",
  "By context band",
  "By wake cause",
  "Wake cause by gap band",
  "Cold rebuilds: 2 requests",
  "Compactions",
  "Top sessions",
  "Unpriced models (counted at zero cost)",
  "Price table v1. Coverage: 3 transcripts indexed, facet backlog 1.",
];

describe("renderCostReportText", () => {
  it("the text renderer prints every section and the list-price caveat", () => {
    const text = renderCostReportText(costReport(fixture.openReadOnly(), SCENARIO_WINDOW));
    const lines = text.split("\n");

    for (const section of SECTIONS) expect(lines.some((line) => line.startsWith(section))).toBe(true);
    expect(text).toContain(LIST_PRICE_CAVEAT);
    expect(lines.some((line) => line.startsWith("  ask_user_answer "))).toBe(true);
    expect(lines.findIndex((line) => line.startsWith("human"))).toBeLessThan(lines.findIndex((line) => line.startsWith("  human_typed")));
  });

  it("says none for an empty window instead of printing empty tables", () => {
    const text = renderCostReportText(costReport(fixture.openReadOnly(), { since: "2030-01-01" }));

    expect(text).toContain("By model: none");
    expect(text).toContain("Unpriced models: none");
    expect(text).toContain(LIST_PRICE_CAVEAT);
  });
});
