import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { costReport, costReportSchema, type CostReport } from "./cost-report.js";
import { writeEpisodes } from "./episodes.js";
import { SCENARIO_WINDOW, createFixtureGraph, insertInbound, insertRequest, insertSignal, seedCostScenario, type FixtureGraph } from "./fixture.js";
import { priceRequest } from "./price-request.js";
import { PRICE_TABLE_VERSION } from "./prices.js";

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
const actionsOf = (source: CostReport, role: string) => source.byAction.find((entry) => entry.role === role)!.buckets;

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

  it("lists an unlisted model under unpricedModels instead of billing it at a shorter prefix's rate", () => {
    insertRequest(fixture.graph.db, { sessionId: "worker", ts: "2026-09-20T13:00:00Z", model: "claude-opus-5-9", inputTokens: 1_000_000 });

    const withUnlisted = costReport(fixture.openReadOnly(), SCENARIO_WINDOW);

    expect(withUnlisted.unpricedModels).toContainEqual({ model: "claude-opus-5-9", requests: 1, tokens: 1_000_000 });
    expect(find(withUnlisted.byModel, "claude-opus-5-9").costUsd).toBe(0);
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

  it("buckets sessions by stored episode count and names a worker that outlived its brief a standing peer", () => {
    const db = fixture.graph.db;
    insertSignal(db, { sessionId: "worker", ts: "2026-09-20T13:05:00Z", signal: "status_report" });
    insertInbound(db, { sessionId: "worker", ts: "2026-09-21T02:00:00Z", cause: "channel_message" });
    insertRequest(db, { sessionId: "worker", ts: "2026-09-21T02:00:00Z" });
    writeEpisodes(fixture.graph, ["coord", "worker", "miner"]);

    const segmented = costReport(fixture.openReadOnly(), SCENARIO_WINDOW);

    expect(keys(report.byEpisodeCount)).toEqual(["none"]);
    expect(keys(segmented.byEpisodeCount)).toEqual(["1", "2", "none"]);
    expect(find(segmented.byEpisodeCount, "1")).toMatchObject({ sessions: 1, requests: 4 });
    expect(find(segmented.byEpisodeCount, "2")).toMatchObject({ sessions: 1, requests: 1 });
    expect(keys(segmented.byRole)).toEqual(["coordinator", "headless_sdk", "worker:standing_peer"]);
  });

  it("byAction buckets each role's requests by action and sums to the role's cost, text-only included", () => {
    expect(report.byAction.map((entry) => entry.role)).toEqual(report.byRole.map((bucket) => bucket.key));
    for (const role of report.byRole) {
      const buckets = report.byAction.find((entry) => entry.role === role.key)!.buckets;
      expect(buckets.reduce((sum, bucket) => sum + bucket.costUsd, 0)).toBeCloseTo(role.costUsd, 10);
      expect(buckets.reduce((sum, bucket) => sum + bucket.requests, 0)).toBe(role.requests);
    }
    expect(keys(actionsOf(report, "coordinator"))).toEqual(["message", "pr-ci-check", "read-investigate", "text-only"]);
    expect(keys(actionsOf(report, "worker:implementer"))).toEqual(["journal-write"]);
  });

  it("mechanicalShare is the listed classes' cost over the window total", () => {
    const prCheck = find(actionsOf(report, "coordinator"), "pr-ci-check").costUsd;
    const journal = find(actionsOf(report, "worker:implementer"), "journal-write").costUsd;
    const coordinator = find(report.byRole, "coordinator").costUsd;

    expect(report.mechanicalShare.costUsd).toBeCloseTo(prCheck + journal, 10);
    expect(report.mechanicalShare.share).toBeCloseTo((prCheck + journal) / report.totals.costUsd, 10);
    expect(report.mechanicalShare.byRole.find((row) => row.role === "coordinator")?.share).toBeCloseTo(prCheck / coordinator, 10);
    expect(report.mechanicalShare.byRole.find((row) => row.role === "worker:implementer")?.share).toBeCloseTo(1, 10);
  });

  it("a custom mechanicalClasses list changes the share", () => {
    const custom = costReport(fixture.openReadOnly(), { ...SCENARIO_WINDOW, mechanicalClasses: ["message"] });
    const message = find(actionsOf(report, "coordinator"), "message").costUsd;

    expect(custom.mechanicalShare.classes).toEqual(["message"]);
    expect(custom.mechanicalShare.share).toBeCloseTo(message / report.totals.costUsd, 10);
    expect(custom.mechanicalShare.share).not.toBeCloseTo(report.mechanicalShare.share, 3);
  });

  it("caller-supplied action rules replace the defaults", () => {
    const custom = costReport(fixture.openReadOnly(), { ...SCENARIO_WINDOW, actionRules: [{ cls: "scorer", tool: /^Read$/ }] });

    expect(keys(actionsOf(custom, "coordinator"))).toEqual(["other", "scorer", "text-only"]);
  });

  it("JSON output validates against the exported zod schema", () => {
    const parsed = costReportSchema.safeParse(JSON.parse(JSON.stringify(report)));

    expect(parsed.success).toBe(true);
    expect(parsed.data?.priceTableVersion).toBe(PRICE_TABLE_VERSION);
    expect(costReportSchema.safeParse({ ...report, totals: { ...report.totals, requests: -1 } }).success).toBe(false);
  });
});
