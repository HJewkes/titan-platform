import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineStep, type BaseEntry, type FactEntry } from "./entry.js";
import { lintFactEntries, lintLongClaims, lintObservedProducers, lintProjectionCoversReads } from "./lints.js";
import { FACT_PIN_CLASS } from "./pin-classes.js";
import { factoryRegistry } from "./steps/index.js";

const repoRoot = resolve(import.meta.dirname, "../../../..");

function base(overrides: Partial<BaseEntry> = {}): BaseEntry {
  return defineStep({ name: "plain", op: "seed", kind: "software", effect: { class: "read" }, callSites: ["plain"], version: { bump: 0 }, ...overrides });
}

function fact(name: string, overrides: Partial<FactEntry> = {}): FactEntry {
  return defineStep({
    ...base({ name }),
    fact: "ci:green",
    input: z.object({}),
    output: z.object({}),
    materialInputs: [],
    projection: ["green"],
    idempotencyKey: () => name,
    body: "products/factory/src/registry/lints.ts",
    ...overrides,
  });
}

describe("registry lints", () => {
  it("a dependent reading a field outside its producer's projection fails the projection lint", () => {
    const producer = fact("producer", { fact: "head:pushed", projection: ["head"] });
    const covered = fact("covered", { materialInputs: [{ fact: "head:pushed", fields: ["head"] }] });
    const outside = fact("outside", { materialInputs: [{ fact: "head:pushed", fields: ["head", "sha"] }] });
    expect(lintProjectionCoversReads({ entries: [producer, covered] })).toEqual([]);
    expect(lintProjectionCoversReads({ entries: [producer, outside] })).toEqual([expect.objectContaining({ subject: "outside", message: expect.stringContaining("head:pushed.sha") })]);
  });

  it("an observed fact with neither a producer kind nor a TTL fails", () => {
    expect(lintObservedProducers({ mood: { pinClass: "observed" } })).toEqual([expect.objectContaining({ subject: "mood" })]);
    expect(lintObservedProducers({ mood: { pinClass: "observed", ttl: "PT5M" }, tide: { pinClass: "observed", producer: ["MainMoved"] }, pinned: { pinClass: "tree" } })).toEqual([]);
  });

  it("an observed fact whose producer names a kind no source emits fails", () => {
    expect(lintObservedProducers({ mood: { pinClass: "observed", producer: ["MainMoved", "MoodShifted"] } })).toEqual([expect.objectContaining({ message: expect.stringContaining("MoodShifted") })]);
  });

  it("a long-scope claim outside a start set fails, and the same claim in a start set passes", () => {
    const claim = { claims: [{ pool: "contract-path" }] };
    expect(lintLongClaims({ entries: [base({ name: "loose", ...claim })] })).toEqual([expect.objectContaining({ subject: "loose" })]);
    expect(lintLongClaims({ entries: [base({ name: "started", startSet: true, ...claim })] })).toEqual([]);
  });

  it("a fact entry with an empty projection or a missing body fails", () => {
    const exists = (path: string): boolean => existsSync(resolve(repoRoot, path));
    expect(lintFactEntries({ entries: [fact("ok")] }, exists)).toEqual([]);
    expect(lintFactEntries({ entries: [fact("empty", { projection: [] }), fact("gone", { body: "nowhere.ts" })] }, exists).map((violation) => violation.subject)).toEqual(["empty", "gone"]);
  });

  // The factory has no claim or start-set runtime on main yet, so the long-claims lint finds nothing to flag here.
  it("the factory registry passes every lint, the long-claims lint vacuously", () => {
    const exists = (path: string): boolean => existsSync(resolve(repoRoot, path));
    const violations = [
      ...lintProjectionCoversReads(factoryRegistry),
      ...lintObservedProducers(FACT_PIN_CLASS),
      ...lintLongClaims(factoryRegistry),
      ...lintFactEntries(factoryRegistry, exists),
    ];
    expect(violations).toEqual([]);
    expect(factoryRegistry.entries.filter((entry) => "fact" in entry).map((entry) => entry.name)).toEqual(["ci-wait", "sh-await-verdict", "merge"]);
  });
});
