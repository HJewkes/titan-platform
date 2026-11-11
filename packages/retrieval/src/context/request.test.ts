import { describe, expect, it } from "vitest";
import { RetrievalRequestSchema } from "./request.js";

describe("RetrievalRequestSchema", () => {
  it("rejects a context request without a budget and a list request with one", () => {
    const parse = (value: unknown) => RetrievalRequestSchema.safeParse(value).success;

    expect(parse({ mode: "context", query: "q" })).toBe(false);
    expect(parse({ mode: "list", query: "q", budget: { tokens: 10 } })).toBe(false);
    expect(parse({ mode: "list", query: "q" })).toBe(true);
    expect(parse({ mode: "context", query: "q", budget: { tokens: 10 } })).toBe(true);
  });

  it.each([
    { tokens: -1 },
    { tokens: 1.5 },
    { tokens: Number.NaN },
    { tokens: 10, maxTier: 1.5 },
    { tokens: 10, defaultTiers: { notes: -1 } },
    { tokens: 10, quotas: { notes: -0.1 } },
  ])("rejects budgets the planner would throw on", (budget) => {
    expect(RetrievalRequestSchema.safeParse({ mode: "context", query: "q", budget }).success).toBe(false);
  });

  it("rejects an estimator or any unknown key inside the budget", () => {
    const parse = (budget: unknown) => RetrievalRequestSchema.safeParse({ mode: "context", query: "q", budget }).success;

    expect(parse({ tokens: 10, estimateTokens: "x" })).toBe(false);
    expect(parse({ tokens: 10, extra: 1 })).toBe(false);
  });
});
