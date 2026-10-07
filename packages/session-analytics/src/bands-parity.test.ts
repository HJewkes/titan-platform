import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONTEXT_BANDS, GAP_BANDS, contextBand, gapBand, type Band } from "./bands.js";
import { createFixtureGraph, insertPrices, insertRequest, type FixtureGraph } from "./fixture.js";
import { priceRequest } from "./price-request.js";

const MODEL = "claude-fable-5-1";
const TS = "2026-09-18T14:46:39.441Z";

type CostRow = Record<string, number | string | null>;

let fixture: FixtureGraph;

beforeEach(() => {
  fixture = createFixtureGraph();
  insertPrices(fixture.graph);
});
afterEach(() => fixture.close());

function boundaryValues(bands: readonly Band[]): number[] {
  const edges = bands.flatMap((band) => [band.lo, band.hi]).filter(Number.isFinite);
  return [...new Set(edges.flatMap((edge) => [edge - 1, edge, edge + 1]))].filter((value) => value >= 0);
}

function costRow(requestId: string): CostRow {
  return fixture.graph.db.prepare("SELECT * FROM request_cost WHERE request_id = ?").get(requestId) as CostRow;
}

describe("request_cost and the TypeScript bands", () => {
  it("assigns every context band boundary the band contextBand names", () => {
    const values = boundaryValues(CONTEXT_BANDS);
    values.forEach((tokens) => insertRequest(fixture.graph.db, { sessionId: "s", ts: TS, model: MODEL, requestId: `ctx-${tokens}`, inputTokens: tokens }));

    const sql = values.map((tokens) => costRow(`ctx-${tokens}`).context_band);

    expect(sql).toEqual(values.map(contextBand));
    expect(values.length).toBeGreaterThanOrEqual(CONTEXT_BANDS.length * 2);
  });

  it("assigns every gap band boundary the band gapBand names", () => {
    const values = boundaryValues(GAP_BANDS);
    values.forEach((gapMs) => insertRequest(fixture.graph.db, { sessionId: "s", ts: TS, model: MODEL, requestId: `gap-${gapMs}`, gapMs }));

    const sql = values.map((gapMs) => costRow(`gap-${gapMs}`).gap_band);

    expect(sql).toEqual(values.map(gapBand));
  });

  it("prices a split-less cache write as priceRequest does", () => {
    insertRequest(fixture.graph.db, { sessionId: "s", ts: TS, model: MODEL, requestId: "split-less", inputTokens: 10, cacheReadTokens: 1_000, cacheCreationTokens: 40_000, outputTokens: 20 });
    const priced = priceRequest(
      { inputTokens: 10, cacheReadTokens: 1_000, cacheCreationTokens: 40_000, cacheCreation5mTokens: 0, cacheCreation1hTokens: 0, outputTokens: 20 },
      MODEL,
      TS,
    );

    const row = costRow("split-less");

    expect(priced.cacheWrite5mUsd).toBeGreaterThan(0);
    expect(row.cache_write_5m_cost_usd).toBeCloseTo(priced.cacheWrite5mUsd, 12);
    expect(row.cache_write_1h_cost_usd).toBe(priced.cacheWrite1hUsd);
    expect(row.cost_usd).toBeCloseTo(priced.costUsd, 12);
  });
});
