import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { UsageMeasurement } from "../index.js";
import type { HarnessPricingPort, HarnessPriceQuote } from "./index.js";

const eventAt = 1800000000000;
const catalog = {
  id: "fixture-catalog", version: "fixture-v1", provider: "fixture-provider",
  model: "fixture-model", effectiveFrom: "2026-01-01",
  matchingPolicy: { id: "fixture-exact", version: "1" },
  accountingPolicy: { id: "fixture-flat-request", version: "1" },
};
function measurement(): UsageMeasurement {
  return { kind: "delta", responseId: "fixture-response", model: "fixture-model", source: "fixture-evidence",
    tokens: { input: 1, cachedInput: 0, cacheWriteInput: null, output: 1, reasoningOutput: 0, total: 2 }, cost: null };
}
function fixture() {
  const calls: { measurement: UsageMeasurement; atMs: number }[] = [];
  const port: HarnessPricingPort<"fixture-fourth"> = {
    harness: "fixture-fourth",
    quote(value, atMs) {
      calls.push({ measurement: value, atMs });
      if (value.cost?.kind === "reported") return { status: "priced", cost: { ...value.cost, kind: "reported" }, basis: { kind: "reported", source: value.source } };
      if (value.model !== "fixture-model") return { status: "unpriced", reason: "no fixture model price" };
      if (value.tokens.input === null || value.tokens.output === null) return { status: "unpriced", reason: "fixture counters unavailable" };
      return { status: "priced", cost: { usd: 1.25, kind: "estimate" }, basis: { kind: "catalog", atMs, catalog } };
    },
  };
  return { port, calls };
}
function quote<H extends string>(port: HarnessPricingPort<H>, value: UsageMeasurement, atMs: number) {
  return port.quote(value, atMs);
}

describe("neutral pricing service port", () => {
  it("quotes observable work through an open third-adapter port with dated policy evidence", () => {
    const f = fixture(); const usage = measurement(); const result = quote(f.port, usage, eventAt);
    expect(f.calls).toEqual([{ measurement: usage, atMs: eventAt }]);
    expect(result).toEqual({ status: "priced", cost: { usd: 1.25, kind: "estimate" }, basis: { kind: "catalog", atMs: eventAt, catalog } });
    expect(usage.cost).toBeNull();
    expectTypeOf(f.port.harness).toEqualTypeOf<"fixture-fourth">();
  });
  it("keeps unknown model and unavailable counters explicitly unpriced", () => {
    const f = fixture(); const usage = measurement();
    const results = [f.port.quote({ ...usage, model: null }, eventAt),
      f.port.quote({ ...usage, model: "unlisted-fixture" }, eventAt),
      f.port.quote({ ...usage, tokens: { ...usage.tokens, input: null } }, eventAt)];
    expect(results.map(result => result.status)).toEqual(["unpriced", "unpriced", "unpriced"]);
    for (const result of results) expect(result).not.toHaveProperty("cost");
  });
  it("can preserve reported cost when no catalog model matches", () => {
    const result = fixture().port.quote({ ...measurement(), model: null, cost: { usd: 0, kind: "reported" } }, eventAt);
    expect(result).toEqual({ status: "priced", cost: { usd: 0, kind: "reported" }, basis: { kind: "reported", source: "fixture-evidence" } });
  });
  it("requires priced evidence and never gives an unpriced outcome a cost", () => {
    const unpriced: HarnessPriceQuote = { status: "unpriced", reason: "fixture unavailable" };
    // @ts-expect-error unpriced is not a zero-cost estimate
    const free: NonNullable<UsageMeasurement["cost"]> = unpriced.cost;
    // @ts-expect-error a catalog quote carries its accounting-policy version
    const incomplete: HarnessPriceQuote = { status: "priced", cost: { usd: 1, kind: "estimate" }, basis: { kind: "catalog", atMs: eventAt, catalog: { ...catalog, accountingPolicy: { id: "fixture" } } } };
    // @ts-expect-error reported billing must not be labelled a catalog estimate
    const mismatched: HarnessPriceQuote = { status: "priced", cost: { usd: 1, kind: "reported" }, basis: { kind: "catalog", atMs: eventAt, catalog } };
    // @ts-expect-error an unpriced outcome cannot carry a fabricated zero estimate
    const invented: HarnessPriceQuote = { status: "unpriced", reason: "fixture unknown", cost: { usd: 0, kind: "estimate" } };
    expect([free, incomplete, mismatched, invented]).toHaveLength(4);
  });
  it("keeps the contract leaf import-free at runtime and free of provider dependencies", () => {
    const text = readFileSync(new URL("./pricing-port.ts", import.meta.url), "utf8");
    const source = ts.createSourceFile("pricing-port.ts", text, ts.ScriptTarget.Latest, true);
    expect(source.statements.filter(ts.isImportDeclaration).every(node => node.importClause?.isTypeOnly && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text.startsWith("."))).toBe(true);
    expect(text).not.toMatch(/node:|@anthropic-ai|@openai|claude-agent-sdk/);
  });
});
