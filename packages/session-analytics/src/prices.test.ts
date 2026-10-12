import { describe, expect, it } from "vitest";
import { PRICE_TABLE, PRICE_TABLE_VERSION, findPrice, type PriceRow } from "./prices.js";

const TS = "2026-09-18T14:46:39.441Z";

describe("findPrice", () => {
  it("fable cache read is 0.025 of input", () => {
    const fable = findPrice("claude-fable-5-1", TS);

    expect(fable).not.toBeNull();
    expect(fable!.cacheRead / fable!.input).toBeCloseTo(0.025, 10);
    expect(fable!.cacheRead).toBe(0.25);
  });

  it("claude-opus-5[1m] prices as claude-opus-5", () => {
    expect(findPrice("claude-opus-5[1m]", TS)).toMatchObject({ modelPrefix: "claude-opus-5", input: 5.0 });
  });

  it("picks the latest price row effective at the request time", () => {
    const table: PriceRow[] = [
      { modelPrefix: "claude-opus-5", effectiveFrom: "2026-01-01", input: 5, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10, output: 25 },
      { modelPrefix: "claude-opus-5", effectiveFrom: "2026-06-01", input: 6, cacheRead: 0.6, cacheWrite5m: 7.5, cacheWrite1h: 12, output: 30 },
    ];

    expect(findPrice("claude-opus-5", "2026-05-31T23:59:59Z", table)).toMatchObject({ effectiveFrom: "2026-01-01" });
    expect(findPrice("claude-opus-5", "2026-06-01T00:00:00Z", table)).toMatchObject({ effectiveFrom: "2026-06-01" });
    expect(findPrice("claude-opus-5", "2025-12-31T00:00:00Z", table)).toBeNull();
  });

  it("prefers the longest matching prefix over a shorter one", () => {
    expect(findPrice("claude-fable-5-1", TS)).toMatchObject({ modelPrefix: "claude-fable-5-1" });
    expect(findPrice("claude-fable-5", TS)).toMatchObject({ modelPrefix: "claude-fable-5" });
  });

  it("prices the synthetic model at zero rather than leaving it unpriced", () => {
    expect(findPrice("<synthetic>", TS)).toMatchObject({ input: 0, output: 0 });
  });

  it("prices claude-opus-5-5 from its own row", () => {
    expect(findPrice("claude-opus-5-5", TS)).toMatchObject({ modelPrefix: "claude-opus-5-5", input: 4, output: 20 });
  });

  it("does not let claude-opus-5 match claude-opus-5-5", () => {
    const table = PRICE_TABLE.filter((row) => row.modelPrefix === "claude-opus-5");

    expect(findPrice("claude-opus-5-5", TS, table)).toBeNull();
  });

  it("leaves an unlisted claude-opus-5-9 unpriced", () => {
    expect(findPrice("claude-opus-5-9", TS)).toBeNull();
  });

  it("still resolves a dated id", () => {
    expect(findPrice("claude-haiku-4-5-20251001", TS)).toMatchObject({ modelPrefix: "claude-haiku-4-5" });
  });

  it("opus 5.5 cache read is 0.05 of input and sonnet 5.5 is 0.1", () => {
    const opus = findPrice("claude-opus-5-5", TS)!;
    const sonnet = findPrice("claude-sonnet-5-5", TS)!;

    expect(opus.cacheRead / opus.input).toBeCloseTo(0.05, 10);
    expect(sonnet.cacheRead / sonnet.input).toBeCloseTo(0.1, 10);
  });

  it("prices claude-haiku-5-5 from its own row at a tenth of haiku 4.5", () => {
    expect(findPrice("claude-haiku-5-5", TS)).toMatchObject({
      modelPrefix: "claude-haiku-5-5",
      input: 0.1,
      cacheRead: 0.01,
      cacheWrite5m: 0.125,
      cacheWrite1h: 0.2,
      output: 0.5,
    });
  });

  it("resolves dated and context-suffixed haiku 5.5 ids to the haiku 5.5 row", () => {
    expect(findPrice("claude-haiku-5-5-20261001", TS)).toMatchObject({ modelPrefix: "claude-haiku-5-5" });
    expect(findPrice("claude-haiku-5-5[1m]", TS)).toMatchObject({ modelPrefix: "claude-haiku-5-5" });
  });

  it("carries haiku 5.5's long-prompt tier above 100K prompt tokens at 5x", () => {
    expect(findPrice("claude-haiku-5-5", TS)!.longPrompt).toEqual({
      abovePromptTokens: 100_000,
      input: 0.5,
      cacheRead: 0.05,
      cacheWrite5m: 0.625,
      cacheWrite1h: 1,
      output: 2.5,
    });
  });

  it("haiku 5.5 cache read is 0.1 of input", () => {
    const haiku = findPrice("claude-haiku-5-5", TS)!;

    expect(haiku.cacheRead / haiku.input).toBeCloseTo(0.1, 10);
  });

  it("leaves an unlisted claude-haiku-5-6 unpriced", () => {
    expect(findPrice("claude-haiku-5-6", TS)).toBeNull();
  });

  it("carries a table version the report can print", () => {
    expect(PRICE_TABLE_VERSION).toBeGreaterThanOrEqual(1);
    expect(PRICE_TABLE.length).toBeGreaterThan(0);
  });
});
