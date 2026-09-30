import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { costReport } from "./cost-report.js";
import { SCENARIO_WINDOW, WAKE_WINDOW, createFixtureGraph, seedCostScenario, seedWakeScenario, type FixtureGraph } from "./fixture.js";
import { LIST_PRICE_CAVEAT, TOP_WAKE_ROWS, renderCostReportText } from "./render-text.js";
import { PRICE_TABLE_VERSION } from "./prices.js";
import { handoffThreshold } from "./handoff-threshold.js";

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
  "Wake episodes of coordinator, worker:coordinator: ",
  "Wake senders by receiver",
  "Handoff threshold per role, priced at package table v",
  "Teleport exit fill: 0 matched, 0 unmatched",
  "Reviewers over 10 PRs at 0.0 requests each (no reviewers)",
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

  it("lists wake causes by cost per episode, costliest first, with each cause's senders beneath", () => {
    const wakes = createFixtureGraph();
    seedWakeScenario(wakes);
    const report = costReport(wakes.openReadOnly(), WAKE_WINDOW);
    const lines = renderCostReportText(report).split("\n");
    const start = lines.findIndex((line) => line.startsWith("Wake episodes of "));
    const block = lines.slice(start + 2, lines.indexOf("", start));
    const causes = block.filter((line) => !line.startsWith(" ")).map((line) => line.split(/\s+/)[0]);
    wakes.close();

    const byCostPerEpisode = [...report.wakeEpisodes.byCause].sort((a, b) => b.costPerEpisode - a.costPerEpisode).map((bucket) => bucket.key);
    expect(causes).toEqual(byCostPerEpisode.slice(0, TOP_WAKE_ROWS));
    expect(causes[0]).toBe("human_typed");
    expect(lines[start]).toContain("no-action means only read-investigate, text-only, other");
    expect(block.some((line) => line.startsWith("  from broadcast "))).toBe(true);
    expect(lines.some((line) => /^seat-b\s+broadcast\s+seat-a\s+1\s+0\s/.test(line))).toBe(true);
  });

  it("prints each cohort's best K with its half-boot K and the extra cost per request at each configured K", () => {
    const row = (ts: string, fill: number, bootAction: boolean) => ({ sessionId: "s", role: "worker:coordinator", model: "claude-opus-5-5", ts, fill, tokens: { outputTokens: 112_500 }, bootAction });
    const handoff = handoffThreshold([row("2026-09-22T00:00:00Z", 50_000, true), row("2026-09-22T00:01:00Z", 51_000, false)], [], new Map(), { configuredK: [250_000] });
    const text = renderCostReportText({ ...costReport(fixture.openReadOnly(), SCENARIO_WINDOW), handoffThreshold: handoff });

    expect(text).toMatch(/^worker:coordinator\s+claude-opus-5-5\s+1\s+\$2\.25\s+50k\s+1000\s+0\.200\s+200k \(155k\)\s+\$0\.0400\s+\$0\.0013$/m);
    expect(text).toContain("+$/req @250k");
  });
});
