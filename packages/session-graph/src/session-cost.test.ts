import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openSessionGraph, type SessionGraph } from "./graph.js";
import { reconcilePrices, syncPrices, type PriceInput } from "./prices.js";
import { rollupSessions } from "./rollup.js";

const OPUS: PriceInput = { modelPrefix: "claude-opus-5", effectiveFrom: "2026-01-01", input: 5, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10, output: 25 };

interface SessionCostRow {
  session_id: string;
  requests: number;
  usd: number;
  unpriced: number;
  first_ts: string | null;
  last_ts: string | null;
}

let graph: SessionGraph;

function addRequest(sessionId: string, requestId: string, over: { transcript?: number; ts?: string; model?: string; output?: number } = {}): void {
  graph.db.prepare(
    `INSERT INTO request (transcript_id, request_id, byte_offset, session_id, ts, model, input_tokens, cache_read_tokens,
       cache_creation_tokens, cache_creation_5m, cache_creation_1h, output_tokens, context_tokens)
     VALUES (?, ?, ?, ?, ?, ?, 1000, 2000, 0, 0, 0, ?, 3000)`,
  ).run(over.transcript ?? 1, requestId, requestId.length * 100 + (over.transcript ?? 1), sessionId, over.ts ?? "2026-09-01T00:00:00Z",
    over.model ?? "claude-opus-5", over.output ?? 4000);
}

const stored = (sessionId: string) =>
  graph.db.prepare<[string], SessionCostRow>("SELECT * FROM session_cost WHERE session_id = ?").get(sessionId);

const fromView = (sessionId: string) =>
  graph.db.prepare<[string], { requests: number; usd: number }>(
    "SELECT COUNT(*) AS requests, SUM(cost_usd) AS usd FROM request_cost WHERE session_id = ?",
  ).get(sessionId)!;

beforeEach(() => {
  graph = openSessionGraph(":memory:");
  syncPrices(graph, [OPUS], { tableVersion: 1 });
});
afterEach(() => graph.db.close());

describe("session_cost", () => {
  it("matches the request_cost sums for every session after a rollup", () => {
    addRequest("s1", "a", { output: 1000 });
    addRequest("s1", "b", { output: 2000, ts: "2026-09-02T00:00:00Z" });
    addRequest("s2", "c", { output: 3000 });

    rollupSessions(graph, ["s1", "s2"]);

    for (const id of ["s1", "s2"]) {
      expect(stored(id)?.requests).toBe(fromView(id).requests);
      expect(stored(id)?.usd).toBeCloseTo(fromView(id).usd, 12);
    }
    expect(stored("s1")).toMatchObject({ requests: 2, unpriced: 0, first_ts: "2026-09-01T00:00:00Z", last_ts: "2026-09-02T00:00:00Z" });
  });

  it("leaves another session's row unchanged when a delta pass touches one session", () => {
    addRequest("s1", "a");
    addRequest("s2", "b");
    rollupSessions(graph, ["s1", "s2"]);
    graph.db.prepare("UPDATE session_cost SET usd = -1 WHERE session_id = 's2'").run();
    addRequest("s1", "c");

    rollupSessions(graph, ["s1"]);

    expect(stored("s1")?.requests).toBe(2);
    expect(stored("s2")?.usd).toBe(-1);
  });

  it("counts a request copied across two transcripts once", () => {
    addRequest("s1", "a", { transcript: 1 });
    addRequest("s1", "a", { transcript: 2 });

    rollupSessions(graph, ["s1"]);

    expect(stored("s1")?.requests).toBe(1);
    expect(stored("s1")?.usd).toBeCloseTo(fromView("s1").usd, 12);
  });

  it("counts a request without a price as unpriced at zero cost", () => {
    addRequest("s1", "a", { model: "unlisted-model" });

    rollupSessions(graph, ["s1"]);

    expect(stored("s1")).toMatchObject({ requests: 1, usd: 0, unpriced: 1 });
  });

  it("re-derives every row when the price table is replaced", () => {
    addRequest("s1", "a");
    addRequest("s2", "b");
    rollupSessions(graph, ["s1", "s2"]);

    syncPrices(graph, [{ ...OPUS, output: 100 }], { tableVersion: 2 });

    for (const id of ["s1", "s2"]) expect(stored(id)?.usd).toBeCloseTo(fromView(id).usd, 12);
    expect(stored("s1")?.usd).toBeGreaterThan(0.4);
  });

  it("re-derives every row when reconcilePrices changes a rate", () => {
    addRequest("s1", "a");
    rollupSessions(graph, ["s1"]);

    reconcilePrices(graph, [{ ...OPUS, output: 100 }], { tableVersion: 2 });

    expect(stored("s1")?.usd).toBeCloseTo(fromView("s1").usd, 12);
  });
});
