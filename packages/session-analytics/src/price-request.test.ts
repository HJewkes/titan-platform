import { describe, expect, it } from "vitest";
import { priceRequest, type RequestTokens } from "./price-request.js";

const TS = "2026-09-18T14:46:39.441Z";

/** The three requests hand-checked in report.md, session 6d1cbf8b, starting at request #41. */
const HAND_CHECKED: { tokens: RequestTokens; expected: string }[] = [
  { tokens: { inputTokens: 2, cacheReadTokens: 128_823, cacheCreation5mTokens: 0, cacheCreation1hTokens: 468, outputTokens: 398 }, expected: "0.061486" },
  { tokens: { inputTokens: 4, cacheReadTokens: 129_291, cacheCreation5mTokens: 0, cacheCreation1hTokens: 1_359, outputTokens: 306 }, expected: "0.074843" },
  { tokens: { inputTokens: 2, cacheReadTokens: 130_650, cacheCreation5mTokens: 0, cacheCreation1hTokens: 2_520, outputTokens: 329 }, expected: "0.099532" },
];

describe("priceRequest", () => {
  it("prices the three hand-checked requests to $0.061486, $0.074843 and $0.099532", () => {
    const priced = HAND_CHECKED.map(({ tokens }) => priceRequest(tokens, "claude-fable-5-1", TS));

    expect(priced.map((p) => p.costUsd.toFixed(6))).toEqual(HAND_CHECKED.map((h) => h.expected));
    expect(priced.every((p) => p.priced)).toBe(true);
  });

  it("totals the three hand-checked requests to $0.235861", () => {
    const total = HAND_CHECKED.reduce((sum, { tokens }) => sum + priceRequest(tokens, "claude-fable-5-1", TS).costUsd, 0);

    expect(total.toFixed(6)).toBe("0.235861");
  });

  it("returns the five components, which sum to costUsd", () => {
    const p = priceRequest(HAND_CHECKED[1]!.tokens, "claude-fable-5-1", TS);

    expect(p.inputUsd).toBeCloseTo(0.00004, 10);
    expect(p.cacheReadUsd).toBeCloseTo(0.032323, 6);
    expect(p.cacheWrite5mUsd).toBe(0);
    expect(p.cacheWrite1hUsd).toBeCloseTo(0.02718, 10);
    expect(p.outputUsd).toBeCloseTo(0.0153, 10);
    expect(p.inputUsd + p.cacheReadUsd + p.cacheWrite5mUsd + p.cacheWrite1hUsd + p.outputUsd).toBeCloseTo(p.costUsd, 12);
  });

  it("an unknown model is unpriced, not sonnet", () => {
    const tokens: RequestTokens = { inputTokens: 1_000_000, cacheReadTokens: 1_000_000, outputTokens: 1_000_000 };
    const p = priceRequest(tokens, "claude-nextgen-9", TS);

    expect(p).toEqual({ inputUsd: 0, cacheReadUsd: 0, cacheWrite5mUsd: 0, cacheWrite1hUsd: 0, outputUsd: 0, costUsd: 0, priced: false });
  });

  it("prices an unsplit cache creation total at the 5m rate", () => {
    const p = priceRequest({ cacheCreationTokens: 1_000_000 }, "claude-fable-5-1", TS);

    expect(p.cacheWrite5mUsd).toBe(12.5);
    expect(p.cacheWrite1hUsd).toBe(0);
  });

  it("keeps an explicit 1h split rather than folding it into the 5m rate", () => {
    const p = priceRequest({ cacheCreationTokens: 1_000_000, cacheCreation1hTokens: 1_000_000 }, "claude-fable-5-1", TS);

    expect(p.cacheWrite5mUsd).toBe(0);
    expect(p.cacheWrite1hUsd).toBe(20);
  });

  it("treats missing token fields as zero", () => {
    expect(priceRequest({}, "claude-opus-5", TS)).toMatchObject({ costUsd: 0, priced: true });
  });
});
