import { describe, expect, it } from "vitest";
import { priceRequest } from "./price-request.js";
import { findPrice } from "./prices.js";

const TS = "2026-10-20T12:00:00.000Z";

const rates = (input: number, cacheWrite5m: number, cacheWrite1h: number, cacheRead: number, output: number) =>
  ({ input, cacheWrite5m, cacheWrite1h, cacheRead, output });

describe("published 2026 rates", () => {
  it.each([
    ["claude-opus-5-5", rates(4, 5, 8, 0.2, 20)],
    ["claude-opus-5", rates(5, 6.25, 10, 0.5, 25)],
    ["claude-sonnet-5-5", rates(2, 2.5, 4, 0.1, 10)],
    ["claude-sonnet-5", rates(2, 2.5, 4, 0.2, 10)],
    ["claude-fable-5-1", rates(10, 12.5, 20, 0.25, 50)],
    ["claude-mythos-5-1", rates(10, 12.5, 20, 0.25, 50)],
    ["claude-fable-5", rates(10, 12.5, 20, 1, 50)],
    ["claude-haiku-5-5", rates(0.1, 0.125, 0.2, 0.01, 0.5)],
  ])("prices %s at its published rates", (model, expected) => {
    expect(findPrice(model, TS)).toMatchObject(expected);
  });

  it("never prices claude-opus-5-5 at claude-opus-5 rates, dated or suffixed", () => {
    for (const model of ["claude-opus-5-5", "claude-opus-5-5-20260922", "claude-opus-5-5[1m]"]) {
      expect(findPrice(model, TS)).toMatchObject({ modelPrefix: "claude-opus-5-5", cacheRead: 0.2, input: 4 });
    }
  });
});

describe("Sonnet 5.5 cache read cut on 2026-10-07", () => {
  it("charges 0.20 for a cache read the moment before the cut", () => {
    expect(findPrice("claude-sonnet-5-5", "2026-10-06T23:59:59.999Z")).toMatchObject({ cacheRead: 0.2, input: 2 });
  });

  it("charges 0.10 for a cache read from the cut on, with every other rate unchanged", () => {
    expect(findPrice("claude-sonnet-5-5", "2026-10-07T00:00:00.000Z")).toMatchObject(rates(2, 2.5, 4, 0.1, 10));
  });

  it("prices a million cache-read tokens at half the old cost after the cut", () => {
    const before = priceRequest({ cacheReadTokens: 1_000_000 }, "claude-sonnet-5-5", "2026-10-01T00:00:00Z");
    const after = priceRequest({ cacheReadTokens: 1_000_000 }, "claude-sonnet-5-5", "2026-10-08T00:00:00Z");

    expect(before.costUsd).toBeCloseTo(0.2, 10);
    expect(after.costUsd).toBeCloseTo(0.1, 10);
  });
});

describe("Haiku 5.5 long-prompt tier", () => {
  const tokens = (promptTokens: number) => ({
    inputTokens: promptTokens - 60_000, cacheReadTokens: 50_000, cacheCreation5mTokens: 10_000, outputTokens: 1_000_000,
  });

  it("bills a 100k-token prompt, cache reads and writes included, at base rates", () => {
    expect(priceRequest(tokens(100_000), "claude-haiku-5-5", TS).outputUsd).toBeCloseTo(0.5, 10);
  });

  it("bills every component at the long rates once the prompt passes 100k", () => {
    const priced = priceRequest(tokens(100_001), "claude-haiku-5-5", TS);

    expect(priced.outputUsd).toBeCloseTo(2.5, 10);
    expect(priced.cacheReadUsd).toBeCloseTo((50_000 * 0.05) / 1e6, 12);
    expect(priced.cacheWrite5mUsd).toBeCloseTo((10_000 * 0.625) / 1e6, 12);
  });
});
