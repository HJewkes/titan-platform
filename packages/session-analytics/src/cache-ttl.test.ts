import { afterEach, describe, expect, it } from "vitest";
import { cacheTtlReport, cacheTtlWhatIf, cacheTtlWhatIfSchema, renderCacheTtlText, type TtlRequestRow } from "./cache-ttl.js";
import { createFixtureGraph, insertOrigin, insertPrices, insertRequest, insertSession, type FixtureGraph } from "./fixture.js";

const TS = "2026-09-29T12:00:00Z";
const MINUTE = 60_000;
// Opus 5.5 per million tokens: 1h write 8.0, 5m write 5.0, read 0.2.
const OPUS = "claude-opus-5-5";
const WRITE_SAVING = 3.0 / 1e6;
const REBUILD_COST = 4.8 / 1e6;

const request = (overrides: Partial<TtlRequestRow>): TtlRequestRow => ({
  sessionId: "s",
  role: "worker:reviewer",
  profile: "reviewer",
  model: OPUS,
  ts: TS,
  cacheReadTokens: 0,
  cacheWrite1hTokens: 0,
  gapMs: null,
  ...overrides,
});

/** A per-PR reviewer: one boot write, then quick turns that read and extend the cache. */
const reviewerSession = (sessionId: string): TtlRequestRow[] => [
  request({ sessionId, cacheWrite1hTokens: 100_000 }),
  ...[1, 2, 3].map(() => request({ sessionId, cacheReadTokens: 100_000, cacheWrite1hTokens: 5_000, gapMs: 30_000 })),
];

/** An implementer that waits 10 minutes on CI with a 200k context, twice. */
const ciWaitSession: TtlRequestRow[] = [
  request({ sessionId: "impl", role: "worker:implementer", profile: "implementer", cacheWrite1hTokens: 50_000 }),
  ...[1, 2].map(() => request({ sessionId: "impl", role: "worker:implementer", profile: "implementer", cacheReadTokens: 200_000, cacheWrite1hTokens: 1_000, gapMs: 10 * MINUTE })),
];

describe("cacheTtlWhatIf", () => {
  it("reprices 1h writes at the 5m rate for a role with only short gaps", () => {
    const whatIf = cacheTtlWhatIf([...reviewerSession("r1"), ...reviewerSession("r2")]);
    const reviewer = whatIf.byRole[0]!;

    expect(reviewer).toMatchObject({ key: "worker:reviewer", sessions: 2, requests: 8, rebuilds: 0, fiveMinuteLoses: false });
    expect(reviewer.repriceSavingUsd).toBeCloseTo(230_000 * WRITE_SAVING, 10);
    expect(reviewer.netPerSessionUsd).toBeCloseTo(115_000 * WRITE_SAVING, 10);
    expect(whatIf.lossRoles).toEqual([]);
  });

  it("charges a rebuild for each CI-wait gap and flags the role when rebuilds outweigh the saving", () => {
    const whatIf = cacheTtlWhatIf([...reviewerSession("r1"), ...ciWaitSession]);
    const implementer = whatIf.byRole.find((bucket) => bucket.key === "worker:implementer")!;

    expect(implementer).toMatchObject({ rebuilds: 2, rebuildTokens: 400_000, fiveMinuteLoses: true });
    expect(implementer.rebuildCostUsd).toBeCloseTo(400_000 * REBUILD_COST, 10);
    expect(implementer.netSavingUsd).toBeCloseTo(52_000 * WRITE_SAVING - 400_000 * REBUILD_COST, 10);
    expect(whatIf.lossRoles).toEqual(["worker:implementer"]);
    expect(whatIf.byRole.map((bucket) => bucket.key)).toEqual(["worker:reviewer", "worker:implementer"]);
  });

  it("rebuilds from a 5-minute gap on, following the gap bands", () => {
    const rows = [299_999, 300_000].map((gapMs) => request({ cacheReadTokens: 10_000, gapMs }));

    expect(cacheTtlWhatIf(rows).totals).toMatchObject({ rebuilds: 1, rebuildTokens: 10_000 });
    expect(cacheTtlWhatIf(rows).rebuildGapBands).toEqual(["5-60m", ">60m"]);
  });

  it("adds nothing beyond the reprice after an hour-long gap, where the 1h cache had already expired", () => {
    const whatIf = cacheTtlWhatIf([request({ cacheWrite1hTokens: 150_000, gapMs: 90 * MINUTE })]);

    expect(whatIf.totals).toMatchObject({ rebuilds: 0, rebuildCostUsd: 0 });
    expect(whatIf.totals.netSavingUsd).toBeCloseTo(150_000 * WRITE_SAVING, 10);
  });

  it("buckets by spawn profile and leaves unpriced models out", () => {
    const whatIf = cacheTtlWhatIf([...reviewerSession("r1"), request({ sessionId: "x", profile: "reviewer", model: "claude-mystery-9", cacheWrite1hTokens: 1 })]);

    expect(whatIf.byProfile.map((bucket) => [bucket.key, bucket.sessions])).toEqual([["reviewer", 1]]);
    expect(whatIf.unpricedRequests).toBe(1);
    expect(cacheTtlWhatIfSchema.parse(whatIf)).toEqual(whatIf);
  });

  it("renders a loss role in the header and its row", () => {
    const text = renderCacheTtlText(cacheTtlWhatIf([...reviewerSession("r1"), ...ciWaitSession]));

    expect(text).toContain("Roles where 5m loses: worker:implementer");
    expect(text).toMatch(/worker:implementer .* loss\n/);
    expect(text).toMatch(/worker:reviewer .* saves\n/);
  });
});

describe("cacheTtlReport", () => {
  let fixture: FixtureGraph;
  afterEach(() => fixture.close());

  it("reads the graph's requests, roles and profiles for the window", () => {
    fixture = createFixtureGraph();
    const db = fixture.graph.db;
    insertPrices(fixture.graph);
    insertSession(db, { sessionId: "rev", startType: "sdk-cli" });
    insertOrigin(db, { sessionId: "rev", depth: 1, profile: "reviewer", parentName: "coord" });
    insertRequest(db, { sessionId: "rev", ts: "2026-09-29T10:00:00Z", model: OPUS, cacheCreation1h: 100_000 });
    insertRequest(db, { sessionId: "rev", ts: "2026-09-29T10:20:00Z", model: OPUS, cacheReadTokens: 100_000, gapMs: 20 * MINUTE });
    insertRequest(db, { sessionId: "rev", ts: "2026-09-30T10:00:00Z", model: OPUS, cacheCreation1h: 999_999 });

    const whatIf = cacheTtlReport(fixture.openReadOnly(), { since: "2026-09-29", until: "2026-09-30" });

    expect(whatIf.window).toEqual({ since: "2026-09-29", until: "2026-09-30" });
    expect(whatIf.byRole[0]).toMatchObject({ key: "worker:reviewer", requests: 2, rebuilds: 1 });
    expect(whatIf.byProfile[0]!.key).toBe("reviewer");
    expect(whatIf.totals.netSavingUsd).toBeCloseTo(100_000 * WRITE_SAVING - 100_000 * REBUILD_COST, 10);
  });

  it("derives a missing gap from the session's previous request, including one before the window", () => {
    fixture = createFixtureGraph();
    const db = fixture.graph.db;
    insertPrices(fixture.graph);
    insertSession(db, { sessionId: "impl" });
    insertRequest(db, { sessionId: "impl", ts: "2026-09-28T23:55:00Z", model: OPUS, cacheCreation1h: 100_000 });
    insertRequest(db, { sessionId: "impl", ts: "2026-09-29T00:07:00Z", model: OPUS, cacheReadTokens: 100_000 });
    insertRequest(db, { sessionId: "impl", ts: "2026-09-29T00:08:00Z", model: OPUS, cacheReadTokens: 100_000 });

    const whatIf = cacheTtlReport(fixture.openReadOnly(), { since: "2026-09-29", until: "2026-09-30" });

    expect(whatIf.totals).toMatchObject({ requests: 2, rebuilds: 1, rebuildTokens: 100_000 });
  });
});
