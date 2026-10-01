import { describe, expect, it } from "vitest";
import { costReport } from "./cost-report.js";
import { createFixtureGraph, insertActionCall, insertOrigin, insertPrices, insertRequest, insertSession } from "./fixture.js";
import {
  POOLED_REVIEWERS,
  TELEPORT_EVENT,
  costPerRequest,
  handoffThreshold,
  isBootAction,
  parseTeleportEvents,
  sweepK,
  type HandoffRequestRow,
  type TeleportEvent,
} from "./handoff-threshold.js";

const MODEL = "claude-opus-5-5";
/** claude-opus-5-5 bills output at $20 per million tokens and reads cache at $0.20. */
const outputFor = (usd: number) => (usd / 20) * 1_000_000;
const READ_PER_MTOK = 0.2;
const SWEEP = { fromK: 20_000, toK: 1_000_000, stepK: 5_000 };

let clock = 0;
function request(sessionId: string, fill: number, overrides: Partial<HandoffRequestRow> = {}): HandoffRequestRow {
  clock += 1;
  const ts = `2026-09-22T00:${String(Math.floor(clock / 60)).padStart(2, "0")}:${String(clock % 60).padStart(2, "0")}Z`;
  return { sessionId, role: "worker:coordinator", model: MODEL, ts, fill, tokens: {}, bootAction: false, ...overrides };
}

/**
 * Boot costs $2.25 over two requests and ends at 50k; after it the fill climbs 1k, 1k, drops to a
 * compaction and climbs 2k, so growth is 4k over 4 requests. The optimum is f0 + sqrt(2 B g / p) = 200k.
 */
function coordinatorSession(sessionId: string): HandoffRequestRow[] {
  return [
    request(sessionId, 30_000, { tokens: { outputTokens: outputFor(1) } }),
    request(sessionId, 50_000, { tokens: { outputTokens: outputFor(1.25) }, bootAction: true }),
    request(sessionId, 51_000, { tokens: { outputTokens: outputFor(0.5) }, bootAction: true }),
    request(sessionId, 52_000, { tokens: { outputTokens: outputFor(0.5) } }),
    request(sessionId, 40_000),
    request(sessionId, 42_000),
  ];
}

/** A reviewer that boots on its first request at 40k, then grows 2k a request for `after` more requests. */
function reviewerSession(id: string, model: string, after: number): HandoffRequestRow[] {
  const boot = request(id, 40_000, { role: "worker:reviewer", model, tokens: { outputTokens: outputFor(0.3) }, bootAction: true });
  return [boot, ...Array.from({ length: after }, (_, i) => request(id, 40_000 + 2_000 * (i + 1), { role: "worker:reviewer", model }))];
}

const reads = (f0: number, g: number, m: number) => ((m * f0 + (g * m * (m + 1)) / 2) * READ_PER_MTOK) / 1_000_000;

const run = (rows: readonly HandoffRequestRow[], teleports: readonly TeleportEvent[] = [], agents = new Map<string, string[]>()) =>
  handoffThreshold(rows, teleports, agents, { sweep: SWEEP, configuredK: [170_000, 250_000] });

describe("handoffThreshold", () => {
  it("measures boot cost up to the first dispatch, send or write, and boot fill at that request", () => {
    const [session] = run(coordinatorSession("s1")).sessions;

    expect(session).toMatchObject({ sessionId: "s1", requests: 6, bootRequests: 2, bootFill: 50_000, exitFill: 42_000, readPricePerMTok: READ_PER_MTOK });
    expect(session!.bootCostUsd).toBeCloseTo(2.25, 10);
  });

  it("counts only rises in fill growth, so a compaction drop does not cancel the growth before it", () => {
    expect(run(coordinatorSession("s1")).sessions[0]!.growthPerRequest).toBe(1_000);
  });

  it("sweeps K to the closed-form optimum and prices each configured K against it", () => {
    const [cohort] = run(coordinatorSession("s1")).cohorts;

    expect(cohort).toMatchObject({ role: "worker:coordinator", model: MODEL, sessions: 1, bestK: 200_000 });
    expect(cohort!.bestCostPerRequest).toBeCloseTo(2.25 / 150 + 0.2e-6 * 125_000, 12);
    expect(cohort!.atConfigured[1]!.deltaPerRequest).toBeCloseTo(0.00125, 12);
    expect(cohort!.atConfigured[0]!.deltaPerRequest).toBeGreaterThan(0);
  });

  it("the half-boot row moves the optimum down to where only half the boot is paid again", () => {
    expect(run(coordinatorSession("s1")).cohorts[0]!.halfBoot.bestK).toBe(155_000);
  });

  it("averages the fitted terms over the sessions of one role and model", () => {
    const light = coordinatorSession("s2").map((row, i) => (i === 1 ? { ...row, fill: 70_000 } : row));
    const [cohort] = run([...coordinatorSession("s1"), ...light]).cohorts;

    expect(cohort).toMatchObject({ sessions: 2, bootFill: 60_000 });
  });

  it("splits a role by model and leaves a session with no boot action out of the fit", () => {
    const sonnet = coordinatorSession("s2").map((row) => ({ ...row, model: "claude-sonnet-5-5" }));
    const idle = [request("s3", 10_000), request("s3", 20_000)];
    const report = run([...coordinatorSession("s1"), ...sonnet, ...idle]);

    expect(report.cohorts.map((c) => c.model)).toEqual([MODEL, "claude-sonnet-5-5"]);
    expect(report.unbootedSessions).toBe(1);
    expect(report.sessions.map((s) => s.sessionId)).toEqual(["s1", "s2"]);
  });

  it("reports each teleport's exit fill from the outgoing session's last request before it", () => {
    const rows = coordinatorSession("s1");
    const teleportAt = rows[3]!.ts;
    const events = [{ ts: teleportAt, name: "seat-x", fromAgentId: "a1" }, { ts: teleportAt, name: "ghost", fromAgentId: "a9" }];
    const report = run(rows, events, new Map([["a1", ["s1"]]]));

    expect(report.teleports).toEqual([
      expect.objectContaining({ name: "seat-x", sessionId: "s1", exitFill: 52_000, bestK: 200_000, overConfigured: [{ k: 170_000, over: -118_000 }, { k: 250_000, over: -198_000 }] }),
    ]);
    expect(report.unmatchedTeleports).toBe(1);
  });

  it("prices fresh per-PR reviewers against one standing reviewer carrying every PR's context", () => {
    const standing = coordinatorSession("peer").map((row) => ({ ...row, role: "worker:standing_peer" }));
    const { reviewers } = run([...reviewerSession("r1", MODEL, 2), ...reviewerSession("r2", MODEL, 2), ...standing]);

    expect(reviewers.prs).toBe(10);
    expect(reviewers.fresh).toEqual([expect.objectContaining({ model: MODEL, sessions: 2, requestsPerPr: 2, requestsFrom: MODEL })]);
    expect(reviewers.fresh[0]!.costUsd).toBeCloseTo(10 * (0.3 + reads(40_000, 2_000, 2)), 10);
    expect(reviewers.standing[0]!.costUsd).toBeCloseTo(2.25 + reads(50_000, 1_000, 20), 10);
  });

  it("takes each model's requests per PR from its own reviewers, and the newest reviewer cohort for a standing model with none", () => {
    const old = [1, 2, 3].flatMap((i) => reviewerSession(`old${i}`, "claude-sonnet-5", 5));
    const standing = (id: string, model: string) => coordinatorSession(id).map((row) => ({ ...row, role: "worker:standing_peer", model }));
    const { reviewers } = run([...old, ...reviewerSession("new", MODEL, 2), ...standing("peer", MODEL), ...standing("fable", "claude-fable-5-1")]);
    const by = (rows: typeof reviewers.fresh) => Object.fromEntries(rows.map((r) => [r.model, [r.requestsPerPr, r.requestsFrom]]));

    expect(by(reviewers.fresh)).toEqual({ "claude-sonnet-5": [5, "claude-sonnet-5"], [MODEL]: [2, MODEL] });
    expect(by(reviewers.standing)).toEqual({ "claude-fable-5-1": [2, MODEL], [MODEL]: [2, MODEL] });
    expect(reviewers.fresh.find((r) => r.model === MODEL)!.costUsd).toBeCloseTo(10 * (0.3 + reads(40_000, 2_000, 2)), 10);
    expect(reviewers.standing.find((r) => r.model === MODEL)!.costUsd).toBeCloseTo(2.25 + reads(50_000, 1_000, 20), 10);
  });
});

describe("reviewers without a cohort of their own", () => {
  it("falls back to the newest reviewer cohort by latest session, not the session-weighted pool", () => {
    const old = [1, 2, 3].flatMap((i) => reviewerSession(`old${i}`, "claude-sonnet-5", 40));
    const standing = coordinatorSession("peer").map((row) => ({ ...row, role: "worker:standing_peer" }));
    const { reviewers } = run([...old, ...reviewerSession("new", "claude-haiku-4-5", 2), ...standing]);

    expect(reviewers.standing).toEqual([expect.objectContaining({ model: MODEL, requestsPerPr: 2, requestsFrom: "claude-haiku-4-5" })]);
  });

  it("reports zero requests from `pooled` when there are no reviewer sessions at all", () => {
    const standing = coordinatorSession("peer").map((row) => ({ ...row, role: "worker:standing_peer" }));

    expect(run(standing).reviewers.standing).toEqual([expect.objectContaining({ requestsPerPr: 0, requestsFrom: POOLED_REVIEWERS })]);
  });

  it("does not let a session with no growth dilute its cohort's growth", () => {
    const stalled = [request("s2", 30_000, { bootAction: true })];
    const [cohort] = run([...coordinatorSession("s1"), ...stalled]).cohorts;

    expect(cohort).toMatchObject({ sessions: 2, growthPerRequest: 1_000 });
  });
});

describe("costPerRequest", () => {
  it("is undefined when a cycle would not reach one request past boot", () => {
    const params = { bootCostUsd: 1, bootFill: 100_000, growthPerRequest: 1_000, readPricePerMTok: READ_PER_MTOK };

    expect(costPerRequest(params, 100_500)).toBeNull();
    expect(costPerRequest({ ...params, growthPerRequest: 0 }, 200_000)).toBeNull();
    expect(sweepK({ ...params, growthPerRequest: 0 }, SWEEP, [170_000])).toEqual({ bestK: null, bestCostPerRequest: null, atConfigured: [{ k: 170_000, costPerRequest: null, deltaPerRequest: null }] });
  });
});

describe("isBootAction", () => {
  it("a dispatch, a send or a file write ends boot; a read or a status check does not", () => {
    expect(isBootAction([{ tool: "mcp__plugin_agent-chat_agent-chat__agent_spawn" }])).toBe(true);
    expect(isBootAction([{ tool: "mcp__agent-chat__chat_send" }])).toBe(true);
    expect(isBootAction([{ tool: "Edit", writePaths: ["src/a.ts"] }])).toBe(true);
    expect(isBootAction([{ tool: "Read", readPaths: ["src/a.ts"] }, { tool: "mcp__agent-chat__chat_status" }])).toBe(false);
  });
});

describe("parseTeleportEvents", () => {
  it("keeps teleport starts and skips other events and lines that are not JSON", () => {
    const lines = [
      JSON.stringify({ ts: "2026-09-22T01:00:00Z", event: TELEPORT_EVENT, name: "seat-x", from: "a1", to: "a2" }),
      JSON.stringify({ ts: "2026-09-22T01:00:30Z", event: "teleport_completed", name: "seat-x", from: "a1", to: "a2" }),
      JSON.stringify({ ts: "2026-09-22T02:00:00Z", event: TELEPORT_EVENT, from: "a3" }),
      "not json",
      "",
    ];

    expect(parseTeleportEvents(lines)).toEqual([
      { ts: "2026-09-22T01:00:00Z", name: "seat-x", fromAgentId: "a1" },
      { ts: "2026-09-22T02:00:00Z", name: null, fromAgentId: "a3" },
    ]);
  });
});

describe("costReport handoffThreshold", () => {
  it("fits spawned seats from the graph, skips sidechain requests and reads teleports through the injected broker log", () => {
    const fixture = createFixtureGraph();
    const db = fixture.graph.db;
    insertPrices(fixture.graph);
    insertSession(db, { sessionId: "seat" });
    insertOrigin(db, { sessionId: "seat", depth: 1, profile: "opus-coordinator", agentName: "seat-x", agentId: "a1", originKind: "spawned" });
    const seat = { sessionId: "seat", model: MODEL };
    insertRequest(db, { ...seat, ts: "2026-09-22T00:00:00Z", cacheCreation1h: 40_000 });
    insertRequest(db, { ...seat, ts: "2026-09-22T00:01:00Z", cacheReadTokens: 40_000, cacheCreation1h: 10_000 });
    insertActionCall(db, { ...seat, ts: "2026-09-22T00:01:00Z", name: "mcp__agent-chat__agent_spawn" });
    insertRequest(db, { ...seat, ts: "2026-09-22T00:01:30Z", inputTokens: 900_000, isSidechain: true });
    insertRequest(db, { ...seat, ts: "2026-09-22T00:02:00Z", cacheReadTokens: 50_000, cacheCreation1h: 2_000 });
    const brokerLog = [JSON.stringify({ ts: "2026-09-22T00:03:00Z", event: TELEPORT_EVENT, name: "seat-x", from: "a1" }), JSON.stringify({ ts: "2026-09-25T00:00:00Z", event: TELEPORT_EVENT, from: "a1" })];

    const report = costReport(fixture.openReadOnly(), { since: "2026-09-22", until: "2026-09-23", brokerLogLines: () => brokerLog }).handoffThreshold;
    fixture.close();

    expect(report.sessions).toEqual([expect.objectContaining({ role: "worker:coordinator", requests: 3, bootRequests: 2, bootFill: 50_000, growthPerRequest: 2_000, exitFill: 52_000 })]);
    expect(report.teleports).toEqual([expect.objectContaining({ name: "seat-x", sessionId: "seat", exitFill: 52_000 })]);
    expect(report.unmatchedTeleports).toBe(0);
  });
});
