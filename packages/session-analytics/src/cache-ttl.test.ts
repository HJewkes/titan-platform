import { afterEach, describe, expect, it } from "vitest";
import { cacheTtlReport, cacheTtlWhatIf, readTtlRows, cacheTtlWhatIfSchema, renderCacheTtlText, type TtlRequestRow } from "./cache-ttl.js";
import { findPrice } from "./prices.js";
import { createFixtureGraph, insertActionCall, insertOrigin, insertPrices, insertRequest, insertSession, type FixtureGraph } from "./fixture.js";

const TS = "2026-09-29T12:00:00Z";
const MINUTE = 60_000;
// Opus 5.5 per million tokens: 1h write 8.0, 5m write 5.0, read 0.2.
const OPUS = "claude-opus-5-5";
const WRITE_SAVING = 3.0 / 1e6;
const REBUILD_COST = 4.8 / 1e6;

const request = (overrides: Partial<TtlRequestRow>): TtlRequestRow => ({
  isSidechain: false,
  sessionId: "s",
  role: "worker:reviewer",
  profile: "reviewer",
  model: OPUS,
  ts: TS,
  cacheReadTokens: 0,
  cacheWrite1hTokens: 0,
  cacheWrite5mTokens: 0,
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
    expect(text).toMatch(/worker:implementer .* loss .*\n/);
    expect(text).toMatch(/worker:reviewer .* saves .*\n/);
  });
});

describe("cacheTtlWhatIf no-cache alternative", () => {
  // Opus 5.5 input is 4.0 per million, so a 1h write pays 4.0 and a 5m write 1.0 over no-cache.
  const INPUT_RATE = 4.0 / 1e6;
  const oneShot = [request({ sessionId: "one", profile: "oneshot", role: "worker:oneshot", cacheWrite1hTokens: 100_000, cacheWrite5mTokens: 20_000 })];

  it("prices a one-shot profile as cheaper with no cache", () => {
    const whatIf = cacheTtlWhatIf([...oneShot, ...reviewerSession("r1")]);
    const shot = whatIf.byProfile.find((bucket) => bucket.key === "oneshot")!;
    const reviewer = whatIf.byProfile.find((bucket) => bucket.key === "reviewer")!;

    // 100k 1h writes at 8.0 and 20k 5m writes at 5.0, against 4.0 input.
    expect(shot.noCacheNetUsd).toBeCloseTo(100_000 * (8.0 / 1e6 - INPUT_RATE) + 20_000 * (5.0 / 1e6 - INPUT_RATE), 10);
    expect(shot.noCacheCheaper).toBe(true);
    expect(reviewer.noCacheNetUsd).toBeLessThan(0);
    expect(reviewer.noCacheCheaper).toBe(false);
    expect(whatIf.byRole.find((bucket) => bucket.key === "worker:oneshot")!.noCacheCheaper).toBe(true);
    expect(renderCacheTtlText(whatIf)).toMatch(/oneshot .* no-cache\n/);
    expect(renderCacheTtlText(whatIf)).toContain("no-cache net");
  });

  it("existing 5m-against-1h buckets are unchanged", () => {
    const whatIf = cacheTtlWhatIf([...reviewerSession("r1"), ...ciWaitSession, ...oneShot]);
    const implementer = whatIf.byRole.find((bucket) => bucket.key === "worker:implementer")!;

    expect(implementer).toMatchObject({ rebuilds: 2, rebuildTokens: 400_000, fiveMinuteLoses: true });
    expect(implementer.netSavingUsd).toBeCloseTo(52_000 * WRITE_SAVING - 400_000 * REBUILD_COST, 10);
    expect(whatIf.totals.repriceSavingUsd).toBeCloseTo((115_000 + 52_000 + 100_000) * WRITE_SAVING, 10);
    expect(whatIf.lossRoles).toEqual(["worker:implementer"]);
  });
});

/** A planner already on 5m: a boot write, then a turn after `gapMs` that rebuilds the prefix. */
const fiveMinuteSession = (sessionId: string, gapMs: number, rebuilt = 100_000): TtlRequestRow[] => [
  request({ sessionId, profile: "planner", role: "worker:planner", cacheWrite5mTokens: 100_000 }),
  request({ sessionId, profile: "planner", role: "worker:planner", ts: "2026-09-29T12:00:30Z", cacheReadTokens: 100_000 - rebuilt, cacheWrite5mTokens: rebuilt, gapMs }),
];

describe("cacheTtlWhatIf reverse replay", () => {
  const REVERT_SAVING = 4.8 / 1e6;

  it("a 5m profile replayed at 1h turns a 5-60 min gap rebuild into a read", () => {
    const whatIf = cacheTtlWhatIf(fiveMinuteSession("p1", 20 * MINUTE));
    const planner = whatIf.byProfile.find((bucket) => bucket.key === "planner")!;

    expect(planner).toMatchObject({ reverseReverts: 1, reverseTokens: 100_000 });
    expect(planner.reverseSavingUsd).toBeCloseTo(100_000 * REVERT_SAVING, 10);
    expect(whatIf.byRole[0]!.reverseSavingUsd).toBeCloseTo(100_000 * REVERT_SAVING, 10);
    expect(whatIf.totals.reverseSavingUsd).toBeCloseTo(100_000 * REVERT_SAVING, 10);
    expect(renderCacheTtlText(whatIf)).toContain("1h replay saving");
  });

  it("replays over an unpriced middle request, which still holds the cache", () => {
    const rows = [
      request({ sessionId: "u", cacheWrite5mTokens: 30_000 }),
      request({ sessionId: "u", model: "unpriced-model", ts: "2026-09-29T12:00:10Z", cacheReadTokens: 30_000, cacheWrite5mTokens: 70_000, gapMs: 10_000 }),
      request({ sessionId: "u", ts: "2026-09-29T12:00:20Z", cacheWrite5mTokens: 80_000, gapMs: 20 * MINUTE }),
    ];

    expect(cacheTtlWhatIf(rows)).toMatchObject({ unpricedRequests: 1, totals: { reverseReverts: 1, reverseTokens: 80_000 } });
  });

  it("an unpriced 1h write keeps its session out of the replay", () => {
    const rows = [...fiveMinuteSession("m", 20 * MINUTE), request({ sessionId: "m", model: "unpriced-model", cacheWrite1hTokens: 1_000, ts: "2026-09-29T12:01:00Z", gapMs: MINUTE })];

    expect(cacheTtlWhatIf(rows).totals.reverseTokens).toBe(0);
  });

  it("reports the net after the 1h write premium on the writes a replay keeps, per role and profile", () => {
    const whatIf = cacheTtlWhatIf(fiveMinuteSession("p1", 20 * MINUTE));
    const premium = 100_000 * WRITE_SAVING;
    const net = 100_000 * REVERT_SAVING - premium;

    expect(whatIf.totals.reversePremiumUsd).toBeCloseTo(premium, 10);
    expect(whatIf.totals.reverseNetUsd).toBeCloseTo(net, 10);
    expect(whatIf.byRole[0]!.reverseNetUsd).toBeCloseTo(net, 10);
    expect(whatIf.byProfile[0]!.reverseNetUsd).toBeCloseTo(net, 10);
    expect(renderCacheTtlText(whatIf)).toContain("less the 1h write premium");
  });

  it("a replay that reverts nothing is a net loss of the premium", () => {
    const whatIf = cacheTtlWhatIf(fiveMinuteSession("short", 4 * MINUTE));

    expect(whatIf.totals.reverseSavingUsd).toBe(0);
    expect(whatIf.totals.reverseNetUsd).toBeCloseTo(-200_000 * WRITE_SAVING, 10);
  });

  it("reverts no more than the previous prompt held", () => {
    const rows = [request({ sessionId: "s", cacheWrite5mTokens: 30_000 }), request({ sessionId: "s", cacheWrite5mTokens: 80_000, gapMs: 10 * MINUTE })];

    expect(cacheTtlWhatIf(rows).totals.reverseTokens).toBe(30_000);
  });

  it("claims nothing for a first request, a gap under 5 or over 60 minutes, or a session with 1h writes", () => {
    const rows = [
      ...fiveMinuteSession("short", 4 * MINUTE),
      ...fiveMinuteSession("long", 61 * MINUTE),
      request({ sessionId: "first", cacheWrite5mTokens: 50_000 }),
      ...fiveMinuteSession("mixed", 20 * MINUTE),
      request({ sessionId: "mixed", cacheWrite1hTokens: 1_000, ts: "2026-09-29T12:01:00Z", gapMs: MINUTE }),
    ];

    expect(cacheTtlWhatIf(rows).totals).toMatchObject({ reverseReverts: 0, reverseTokens: 0, reverseSavingUsd: 0 });
  });

  it("TP-1549 validation: 1h reads 100% of the prior prefix after a 5-60 min gap, 5m reads 8%", () => {
    const oneHour = [request({ sessionId: "h", cacheWrite1hTokens: 100_000 }), request({ sessionId: "h", cacheReadTokens: 100_000, gapMs: 20 * MINUTE })];
    const fiveMinute = fiveMinuteSession("m", 20 * MINUTE, 92_000);
    const readShare = (rows: TtlRequestRow[]) => rows[1]!.cacheReadTokens / (rows[0]!.cacheWrite1hTokens + rows[0]!.cacheWrite5mTokens);

    expect(readShare(oneHour)).toBe(1);
    expect(readShare(fiveMinute)).toBe(0.08);
    expect(cacheTtlWhatIf(oneHour).totals).toMatchObject({ rebuilds: 1, rebuildTokens: 100_000, reverseTokens: 0 });
    expect(cacheTtlWhatIf(fiveMinute).totals).toMatchObject({ reverseReverts: 1, reverseTokens: 92_000 });
  });

  it("leaves the 5m-against-1h and no-cache numbers as they were", () => {
    const base = cacheTtlWhatIf([...reviewerSession("r1"), ...ciWaitSession]).totals;
    const withPlanner = cacheTtlWhatIf([...reviewerSession("r1"), ...ciWaitSession, ...fiveMinuteSession("p1", 20 * MINUTE)]).totals;

    expect(withPlanner.netSavingUsd).toBeCloseTo(base.netSavingUsd, 10);
    expect(withPlanner).toMatchObject({ repriceSavingUsd: base.repriceSavingUsd, rebuilds: base.rebuilds, rebuildCostUsd: base.rebuildCostUsd });
    expect(withPlanner.noCacheNetUsd).toBeGreaterThan(base.noCacheNetUsd);
  });

  it("a sidechain request is never the previous prompt of a main-chain request", () => {
    const sessionId = "p2";
    const rows = [
      request({ sessionId, profile: "planner", role: "worker:planner", cacheWrite5mTokens: 1_000 }),
      request({ sessionId, profile: "planner", role: "worker:planner", isSidechain: true, ts: "2026-09-29T12:00:10Z", cacheWrite5mTokens: 90_000 }),
      request({ sessionId, profile: "planner", role: "worker:planner", ts: "2026-09-29T12:00:30Z", cacheWrite5mTokens: 50_000, gapMs: 20 * MINUTE }),
    ];

    expect(cacheTtlWhatIf(rows).totals).toMatchObject({ reverseReverts: 1, reverseTokens: 1_000 });
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
  it("takes a legacy row's total cache_creation_tokens as its 5m write and prefers the explicit 5m column otherwise", () => {
    fixture = createFixtureGraph();
    const db = fixture.graph.db;
    insertPrices(fixture.graph);
    insertSession(db, { sessionId: "legacy" });
    insertSession(db, { sessionId: "explicit" });
    insertRequest(db, { sessionId: "legacy", ts: "2026-09-29T10:00:00Z", model: OPUS, cacheCreationTokens: 40_000 });
    insertRequest(db, { sessionId: "explicit", ts: "2026-09-29T10:00:00Z", model: OPUS, cacheCreation5m: 25_000, cacheCreationTokens: 999_999 });

    const rows = readTtlRows(fixture.openReadOnly(), { since: "2026-09-29", until: "2026-09-30" });
    const writes = Object.fromEntries(rows.map((row) => [row.sessionId, row.cacheWrite5mTokens]));
    const whatIf = cacheTtlReport(fixture.openReadOnly(), { since: "2026-09-29", until: "2026-09-30" });

    expect(writes).toEqual({ legacy: 40_000, explicit: 25_000 });
    const price = findPrice(OPUS, "2026-09-29T10:00:00Z")!;
    expect(whatIf.totals.noCacheNetUsd).toBeCloseTo((65_000 * (price.cacheWrite5m - price.input)) / 1e6, 10);
  });

  it("splits rebuild cost by the last action before the gap: ci-wait, other Bash, end of turn", () => {
    fixture = createFixtureGraph();
    const db = fixture.graph.db;
    insertPrices(fixture.graph);
    insertSession(db, { sessionId: "impl" });
    const at = (minute: number) => `2026-09-29T10:${String(minute).padStart(2, "0")}:00Z`;
    const step = (minute: number, tool: string, heads: string | null, extra: { isSidechain?: boolean } = {}) => {
      insertRequest(db, { sessionId: "impl", ts: at(minute), model: OPUS, cacheReadTokens: 100_000, ...extra });
      if (tool) insertActionCall(db, { sessionId: "impl", ts: at(minute), name: tool, ...(heads ? { signal: "command_heads", detail: heads } : {}) });
    };
    step(0, "Bash", "gh pr checks");
    step(10, "Bash", "ls");
    step(20, "", null);
    step(30, "Bash", "git status;gh run watch");
    // A subagent request between two main-thread requests must not become the main thread's previous action.
    step(32, "Bash", "ls", { isSidechain: true });
    step(45, "", null);

    const whatIf = cacheTtlReport(fixture.openReadOnly(), { since: "2026-09-29", until: "2026-09-30" });
    const by = Object.fromEntries(whatIf.byGapCause.map((c) => [c.cause, c]));

    expect(whatIf.byGapCause.map((c) => c.cause)).toEqual(["ci-wait", "other-bash", "end-of-turn"]);
    expect(by["ci-wait"]).toMatchObject({ rebuilds: 2, rebuildTokens: 200_000 });
    expect(by["other-bash"]).toMatchObject({ rebuilds: 1, rebuildTokens: 100_000 });
    expect(by["end-of-turn"]).toMatchObject({ rebuilds: 1, rebuildTokens: 100_000 });
    expect(by["ci-wait"]!.rebuildCostUsd).toBeCloseTo(200_000 * REBUILD_COST, 10);
    const total = whatIf.byGapCause.reduce((sum, c) => sum + c.rebuildCostUsd, 0);
    expect(total).toBeCloseTo(whatIf.totals.rebuildCostUsd, 10);
    expect(renderCacheTtlText(whatIf)).toMatch(/By gap cause[\s\S]*ci-wait +2 /);
  });
});
