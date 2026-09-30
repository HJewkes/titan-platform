import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { costReport } from "./cost-report.js";
import { SCENARIO_WINDOW, createFixtureGraph, seedCostScenario, type FixtureGraph } from "./fixture.js";
import { LIST_PRICE_CAVEAT, renderCostReportText } from "./render-text.js";
import { PRICE_TABLE_VERSION } from "./prices.js";

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
  "By action per role",
  "Mechanical share: ",
  "By episode count",
  "By initiative",
  "By context band",
  "By wake cause",
  "Wake cause by gap band",
  "Cold rebuilds: 2 requests",
  "Compactions",
  "Top sessions",
  "Unpriced models (counted at zero cost)",
  `Price table v${PRICE_TABLE_VERSION}. Coverage: 3 transcripts indexed, facet backlog 1.`,
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

  it("prints each role's action classes under it and the mechanical share per role", () => {
    const report = costReport(fixture.openReadOnly(), SCENARIO_WINDOW);
    const lines = renderCostReportText(report).split("\n");
    const coordinator = lines.findIndex((line, i) => i > lines.indexOf("By action per role") && line.startsWith("coordinator "));

    expect(lines.slice(coordinator + 1, coordinator + 5).map((line) => line.trim().split(/\s+/)[0]).sort()).toEqual(["message", "pr-ci-check", "read-investigate", "text-only"]);
    expect(lines.find((line) => line.startsWith("Mechanical share: "))).toContain(`${(report.mechanicalShare.share * 100).toFixed(1)}%`);
    expect(lines.find((line) => line.startsWith("Mechanical share: "))).toContain("classes journal-write, pr-ci-check");
    expect(lines.some((line) => /^worker:implementer\s+\$\S+\s+100\.0%$/.test(line))).toBe(true);
  });

  it("says none for an empty window instead of printing empty tables", () => {
    const text = renderCostReportText(costReport(fixture.openReadOnly(), { since: "2030-01-01" }));

    expect(text).toContain("By model: none");
    expect(text).toContain("Unpriced models: none");
    expect(text).toContain(LIST_PRICE_CAVEAT);
  });
});
