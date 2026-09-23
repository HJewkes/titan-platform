import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openSessionGraph, type SessionGraph } from "./graph.js";
import { syncPrices, type PriceInput } from "./prices.js";

const GENESIS = "2026-01-01";
const OPUS: PriceInput = { modelPrefix: "claude-opus-5", effectiveFrom: GENESIS, input: 5, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10, output: 25 };
const FABLE: PriceInput = { modelPrefix: "claude-fable-5-1", effectiveFrom: GENESIS, input: 10, cacheRead: 0.25, cacheWrite5m: 12.5, cacheWrite1h: 20, output: 50 };
const FABLE_BASE: PriceInput = { ...FABLE, modelPrefix: "claude-fable-5" };

interface RequestRow {
  request_id: string;
  model?: string;
  ts?: string;
  transcript_id?: number;
  byte_offset?: number;
  input_tokens?: number;
  cache_read_tokens?: number;
  cache_creation_tokens?: number;
  cache_creation_5m?: number;
  cache_creation_1h?: number;
  output_tokens?: number;
  context_tokens?: number;
  gap_ms?: number | null;
  ctx_delta?: number | null;
}

let graph: SessionGraph;

function addRequest(row: RequestRow): void {
  const full = {
    model: "claude-opus-5", ts: "2026-09-01T00:00:00Z", transcript_id: 1, byte_offset: 0,
    input_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0, cache_creation_5m: 0, cache_creation_1h: 0,
    output_tokens: 0, context_tokens: 0, gap_ms: null, ctx_delta: null, ...row,
  };
  graph.db.prepare(
    `INSERT INTO request (transcript_id, request_id, byte_offset, session_id, ts, model, input_tokens, cache_read_tokens,
       cache_creation_tokens, cache_creation_5m, cache_creation_1h, output_tokens, context_tokens, gap_ms, ctx_delta)
     VALUES (@transcript_id, @request_id, @byte_offset, 's', @ts, @model, @input_tokens, @cache_read_tokens,
       @cache_creation_tokens, @cache_creation_5m, @cache_creation_1h, @output_tokens, @context_tokens, @gap_ms, @ctx_delta)`,
  ).run(full);
}

function addBlock(byteOffset: number, blockIndex: number, source: string, chars: number): void {
  graph.db.prepare(
    "INSERT INTO context_block (transcript_id, byte_offset, block_index, session_id, ts, source, chars) VALUES (1, ?, ?, 's', '2026-09-01T00:00:00Z', ?, ?)",
  ).run(byteOffset, blockIndex, source, chars);
}

const cost = (requestId: string) =>
  graph.db.prepare("SELECT * FROM request_cost WHERE request_id = ?").get(requestId) as Record<string, number | string | null>;

beforeEach(() => {
  graph = openSessionGraph(":memory:");
  syncPrices(graph, [OPUS, FABLE, FABLE_BASE], { tableVersion: 1 });
});
afterEach(() => graph.db.close());

describe("syncPrices", () => {
  it("replaces every price row and stamps the table version and source", () => {
    syncPrices(graph, [FABLE], { tableVersion: 2, source: "test" });

    const rows = graph.db.prepare("SELECT model, table_version, source FROM price").all();
    expect(rows).toEqual([{ model: "claude-fable-5-1", table_version: 2, source: "test" }]);
  });
});

describe("request_cost", () => {
  it("request_cost prices a fable request with the 0.25 cache read rate", () => {
    addRequest({ request_id: "r", model: "claude-fable-5-1", input_tokens: 1000, cache_read_tokens: 1_000_000, output_tokens: 2000 });

    const row = cost("r");

    expect(row.price_model).toBe("claude-fable-5-1");
    expect(row.cache_read_cost_usd).toBeCloseTo(0.25, 9);
    expect(row.cost_usd).toBeCloseTo(0.01 + 0.25 + 0.1, 9);
  });

  it("a model with a [1m] suffix matches its base price row", () => {
    addRequest({ request_id: "r", model: "claude-opus-5[1m]", input_tokens: 1_000_000 });

    const row = cost("r");

    expect(row).toMatchObject({ price_model: "claude-opus-5", priced: 1 });
    expect(row.input_cost_usd).toBeCloseTo(5, 9);
  });

  it("an unpriced model has priced = 0 and cost 0", () => {
    addRequest({ request_id: "r", model: "gpt-9", input_tokens: 1_000_000, output_tokens: 1_000_000 });

    expect(cost("r")).toMatchObject({ priced: 0, price_model: null, cost_usd: 0 });
  });

  it("a later effective_from row wins for later requests only", () => {
    syncPrices(graph, [OPUS, { ...OPUS, effectiveFrom: "2026-06-01", input: 7 }], { tableVersion: 2 });
    addRequest({ request_id: "before", ts: "2026-05-31T23:59:59Z", input_tokens: 1_000_000 });
    addRequest({ request_id: "after", ts: "2026-06-01T00:00:00Z", input_tokens: 1_000_000 });
    addRequest({ request_id: "pre-genesis", ts: "2025-12-31T23:59:59Z", input_tokens: 1_000_000 });

    expect(cost("before").input_cost_usd).toBeCloseTo(5, 9);
    expect(cost("after").input_cost_usd).toBeCloseTo(7, 9);
    expect(cost("pre-genesis")).toMatchObject({ priced: 0, cost_usd: 0 });
  });

  it("is_cold follows the 20 percent and 20k rule", () => {
    addRequest({ request_id: "cold", context_tokens: 100_000, cache_read_tokens: 19_999, cache_creation_tokens: 20_000 });
    addRequest({ request_id: "warm-read", context_tokens: 100_000, cache_read_tokens: 20_000, cache_creation_tokens: 20_000 });
    addRequest({ request_id: "small-write", context_tokens: 100_000, cache_read_tokens: 0, cache_creation_tokens: 19_999 });

    expect(cost("cold").is_cold).toBe(1);
    expect(cost("warm-read").is_cold).toBe(0);
    expect(cost("small-write").is_cold).toBe(0);
  });

  it("context_band and gap_band boundaries are half-open", () => {
    const cases: [number, number | null, string, string | null][] = [
      [49_999, 299_999, "<50k", "<5m"],
      [50_000, 300_000, "50-100k", "5-60m"],
      [99_999, 3_599_999, "50-100k", "5-60m"],
      [100_000, 3_600_000, "100-200k", ">60m"],
      [199_999, null, "100-200k", null],
      [200_000, 0, "200k+", "<5m"],
    ];
    cases.forEach(([context, gap], i) => addRequest({ request_id: `r${i}`, context_tokens: context, gap_ms: gap }));

    const bands = cases.map((_, i) => [cost(`r${i}`).context_band, cost(`r${i}`).gap_band]);

    expect(bands).toEqual(cases.map(([, , context, gap]) => [context, gap]));
  });
});

describe("context_contribution", () => {
  it("context_contribution shares ctx_delta across blocks in proportion to chars", () => {
    addRequest({ request_id: "a", byte_offset: 100, ctx_delta: 500 });
    addBlock(100, 0, "assistant_text", 5000);
    addBlock(150, 0, "tool_result", 300);
    addBlock(160, 0, "human", 100);
    addBlock(170, 0, "attachment", 600);
    addRequest({ request_id: "b", byte_offset: 200, ctx_delta: 1000 });

    const rows = graph.db.prepare("SELECT source, request_id, est_tokens FROM context_contribution ORDER BY byte_offset").all();

    expect(rows).toEqual([
      { source: "assistant_text", request_id: "b", est_tokens: null },
      { source: "tool_result", request_id: "b", est_tokens: 300 },
      { source: "human", request_id: "b", est_tokens: 100 },
      { source: "attachment", request_id: "b", est_tokens: 600 },
    ]);
  });
});
