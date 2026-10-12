import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFixtureGraph, insertPrices, insertRequest, type FixtureGraph } from "./fixture.js";
import { priceRequest, type RequestTokens } from "./price-request.js";

const MODEL = "claude-haiku-5-5";
const TS = "2026-10-11T12:00:00.000Z";
const PROMPT_SIZES = [99_999, 100_000, 100_001, 400_000];

let fixture: FixtureGraph;

beforeEach(() => {
  fixture = createFixtureGraph();
  insertPrices(fixture.graph);
});
afterEach(() => fixture.close());

function sqlCost(requestId: string): Record<string, number> {
  return fixture.graph.db.prepare("SELECT * FROM request_cost WHERE request_id = ?").get(requestId) as Record<string, number>;
}

/** Fixed writes and output, with cache read filling the rest of the prompt. */
function tokensFor(promptTokens: number): RequestTokens {
  return { inputTokens: 500, cacheReadTokens: promptTokens - 3_500, cacheCreation5mTokens: 1_000, cacheCreation1hTokens: 2_000, outputTokens: 800 };
}

describe("haiku 5.5 long-prompt tier in request_cost and priceRequest", () => {
  it.each(PROMPT_SIZES)("agrees on every component at %i prompt tokens", (promptTokens) => {
    const t = tokensFor(promptTokens);
    insertRequest(fixture.graph.db, {
      sessionId: "s", ts: TS, model: MODEL, requestId: `p-${promptTokens}`, inputTokens: t.inputTokens,
      cacheReadTokens: t.cacheReadTokens, cacheCreation5m: t.cacheCreation5mTokens, cacheCreation1h: t.cacheCreation1hTokens, outputTokens: t.outputTokens,
    });

    const ts = priceRequest(t, MODEL, TS);
    const row = sqlCost(`p-${promptTokens}`);

    expect(row.context_tokens).toBe(promptTokens);
    expect(row.input_cost_usd).toBeCloseTo(ts.inputUsd, 12);
    expect(row.cache_read_cost_usd).toBeCloseTo(ts.cacheReadUsd, 12);
    expect(row.cache_write_5m_cost_usd).toBeCloseTo(ts.cacheWrite5mUsd, 12);
    expect(row.cache_write_1h_cost_usd).toBeCloseTo(ts.cacheWrite1hUsd, 12);
    expect(row.output_cost_usd).toBeCloseTo(ts.outputUsd, 12);
    expect(row.cost_usd).toBeCloseTo(ts.costUsd, 12);
  });

  it("switches to the long rates strictly above 100,000 prompt tokens", () => {
    expect(priceRequest(tokensFor(100_000), MODEL, TS).outputUsd).toBeCloseTo((800 * 0.5) / 1e6, 15);
    expect(priceRequest(tokensFor(100_001), MODEL, TS).outputUsd).toBeCloseTo((800 * 2.5) / 1e6, 15);
  });

  it("leaves an unknown model unpriced in the view", () => {
    insertRequest(fixture.graph.db, { sessionId: "s", ts: TS, model: "claude-haiku-5-6", requestId: "unknown", inputTokens: 200_000 });

    expect(sqlCost("unknown")).toMatchObject({ priced: 0, cost_usd: 0 });
  });
});
