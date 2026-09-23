import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { costReport, costReportSchema, type CostReport } from "./cost-report.js";
import { SCENARIO_WINDOW, createFixtureGraph, seedCostScenario, type FixtureGraph } from "./fixture.js";
import { priceRequest } from "./price-request.js";

let fixture: FixtureGraph;
let report: CostReport;

beforeEach(() => {
  fixture = createFixtureGraph();
  seedCostScenario(fixture);
  report = costReport(fixture.openReadOnly(), SCENARIO_WINDOW);
});
afterEach(() => fixture.close());

const keys = (buckets: readonly { key: string }[]) => buckets.map((bucket) => bucket.key).sort();
const find = <T extends { key: string }>(buckets: readonly T[], key: string) => buckets.find((bucket) => bucket.key === key)!;

describe("costReport", () => {
  it("totals equal the sum of the five token classes", () => {
    const classCost = report.byTokenClass.reduce((sum, row) => sum + row.costUsd, 0);
    const fable = priceRequest({ cacheReadTokens: 120_000, outputTokens: 200 }, "claude-fable-5-1", "2026-09-20T12:01:00Z").costUsd;

    expect(report.byTokenClass.map((row) => row.tokenClass)).toEqual(["input", "cache_read", "cache_write_5m", "cache_write_1h", "output"]);
    expect(report.totals.costUsd).toBeCloseTo(classCost, 10);
    expect(report.totals.costUsd).toBeGreaterThan(fable);
    expect(report.byTokenClass.find((row) => row.tokenClass === "input")?.tokens).toBe(1_610);
    expect(report.byTokenClass.find((row) => row.tokenClass === "cache_write_5m")?.tokens).toBe(32_000);
    expect(report.totals).toMatchObject({ requests: 6, sessions: 3 });
  });

  it("groups by class, role, initiative, context band and wake cause", () => {
    expect(keys(report.byClass)).toEqual(["agent_spawned", "headless_sdk", "human_interactive"]);
    expect(find(report.byClass, "human_interactive")).toMatchObject({ requests: 4, sessions: 1 });
    expect(keys(report.byRole)).toEqual(["coordinator", "headless_sdk", "worker:implementer"]);
    expect(find(report.byInitiative, "repo:titan-platform")).toMatchObject({ requests: 5, sessions: 2 });
    expect(keys(report.byInitiative)).toEqual(["other:miner", "repo:titan-platform"]);
    expect(keys(report.byContextBand)).toEqual(["100-200k", "50-100k", "<50k"]);
    expect(find(report.byContextBand, "<50k").requests).toBe(3);
    expect(keys(report.byWakeCause)).toEqual(["channel_message", "human", "tool_result"]);
    expect(keys(report.byAccount)).toEqual(["default", "work"]);
  });

  it("reports ask_user_answer beside human_typed and splits mid_loop deliveries", () => {
    const human = find(report.byWakeCause, "human");
    const channel = find(report.byWakeCause, "channel_message");
    const fable = priceRequest({ cacheReadTokens: 120_000, outputTokens: 200 }, "claude-fable-5-1", "2026-09-20T12:01:00Z").costUsd;

    expect(human.requests).toBe(3);
    expect(keys(human.parts)).toEqual(["ask_user_answer", "human_typed"]);
    expect(find(human.parts, "ask_user_answer").requests).toBe(1);
    expect(human.costUsd).toBeCloseTo(human.parts.reduce((sum, part) => sum + part.costUsd, 0), 10);
    expect(channel).toMatchObject({ requests: 2, midLoopRequests: 1, parts: [] });
    expect(channel.midLoopCostUsd).toBeCloseTo(fable, 10);
  });

  it("reports cold-rebuild cost by gap band and cause", () => {
    const ask = priceRequest({ cacheReadTokens: 1_000, cacheCreation1hTokens: 50_000, outputTokens: 100 }, "claude-opus-5", "2026-09-20T12:00:00Z").costUsd;

    expect(report.coldRebuild.requests).toBe(2);
    expect(report.coldRebuild.byGapBandAndCause.map(({ wakeCause, gapBand, requests }) => ({ wakeCause, gapBand, requests }))).toEqual([
      { wakeCause: "ask_user_answer", gapBand: ">60m", requests: 1 },
      { wakeCause: "tool_result", gapBand: "<5m", requests: 1 },
    ]);
    expect(report.coldRebuild.byGapBandAndCause[0]!.costUsd).toBeCloseTo(ask, 10);
    expect(report.wakeCauseByGapBand.find((cell) => cell.wakeCause === "channel_message")).toMatchObject({ gapBand: "<5m", requests: 2 });
  });

  it("lists unpriced models", () => {
    expect(report.unpricedModels).toEqual([{ model: "claude-mystery-9", requests: 1, tokens: 110 }]);
    expect(report.totals.unpricedRequests).toBe(1);
    expect(find(report.byModel, "claude-mystery-9").costUsd).toBe(0);
  });

  it("counts compactions in the window and the facet backlog", () => {
    expect(report.compactions).toEqual({ total: 2, manual: 1, auto: 1, midLoop: 1, droppedTokens: 100_000 });
    expect(report.coverage).toEqual({ transcriptsIndexed: 3, transcriptsDiscovered: null, facetBacklog: 1 });
    expect(costReport(fixture.openReadOnly(), { ...SCENARIO_WINDOW, facetVersion: 4, transcriptsDiscovered: 5 }).coverage).toEqual({
      transcriptsIndexed: 3,
      transcriptsDiscovered: 5,
      facetBacklog: 3,
    });
  });

  it("ranks top sessions by cost and carries their tags", () => {
    const top = costReport(fixture.openReadOnly(), { ...SCENARIO_WINDOW, top: 2 }).topSessions;

    expect(top.map((row) => row.sessionId)).toEqual(["coord", "worker"]);
    expect(top[1]).toMatchObject({ sessionClass: "agent_spawned", role: "worker:implementer", initiative: "repo:titan-platform", account: "work" });
  });

  it("JSON output validates against the exported zod schema", () => {
    const parsed = costReportSchema.safeParse(JSON.parse(JSON.stringify(report)));

    expect(parsed.success).toBe(true);
    expect(parsed.data?.priceTableVersion).toBe(1);
    expect(costReportSchema.safeParse({ ...report, totals: { ...report.totals, requests: -1 } }).success).toBe(false);
  });
});
