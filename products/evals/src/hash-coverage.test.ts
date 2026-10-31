import { describe, expect, it } from "vitest";
import { caseHash, scorecardKeyHash, suiteHash, unitHash, variantHash } from "./hash.js";
import { EvalCaseSchema, ScorecardSchema, SuiteSpecSchema, UnitSpecSchema, VariantSpecSchema, parseSpec } from "./spec/index.js";
import type { EvalCase, Scorecard, SuiteSpec, UnitSpec, VariantSpec } from "./spec/index.js";
import { asRecord, readFixtureObject, unvalidated } from "./test-fixtures.js";

/** Every leaf changes; an absent field gains a value. */
function mutate(value: unknown): unknown {
  if (value === undefined || value === null) return "mutated";
  if (typeof value === "string") return `${value}-mutated`;
  if (typeof value === "number") return value + 1;
  if (typeof value === "boolean") return !value;
  if (Array.isArray(value)) return value.length > 0 ? value.map(mutate) : ["mutated"];
  const entries = Object.entries(value);
  return entries.length > 0 ? Object.fromEntries(entries.map(([key, item]) => [key, mutate(item)])) : { mutated: true };
}

interface Coverage {
  name: string;
  keys: string[];
  /** Whether replacing this field with a mutated value changes the hash. */
  moves: (key: string) => boolean;
  /** The fields the design leaves out of identity; any other schema field must move the hash. */
  excluded: string[];
}

function coverage<T extends object>(name: string, keys: string[], fixture: Record<string, unknown>, hash: (spec: T) => string, excluded: string[]): Coverage {
  const moves = (key: string) => hash(unvalidated<T>({ ...fixture, [key]: mutate(fixture[key]) })) !== hash(unvalidated<T>(fixture));
  return { name, keys, moves, excluded };
}

const scorecard = readFixtureObject("scorecard.json");

const COVERAGE: Coverage[] = [
  coverage<UnitSpec>("unit", Object.keys(UnitSpecSchema.shape), readFixtureObject("unit.json"), unitHash, ["title", "description", "acceptance", "visibility"]),
  coverage<EvalCase>("case", Object.keys(EvalCaseSchema.shape), readFixtureObject("cases/standup-note.json"), caseHash, ["id", "unit", "tags", "humanMinutes", "solvable", "visibility"]),
  coverage<VariantSpec>("variant", Object.keys(VariantSpecSchema.shape), readFixtureObject("variants/single-pass.json"), variantHash, ["id", "notes", "parents"]),
  coverage<SuiteSpec>("suite", Object.keys(SuiteSpecSchema.shape), readFixtureObject("suite.json"), suiteHash, ["id", "version"]),
  coverage<Scorecard["keys"]>("scorecard key", Object.keys(ScorecardSchema.shape.keys.shape), asRecord(scorecard.keys), scorecardKeyHash, ["env"]),
];

describe.each(COVERAGE)("the $name hash", ({ keys, moves, excluded }) => {
  it("names only real schema fields as excluded", () => {
    expect(keys).toEqual(expect.arrayContaining(excluded));
  });

  it.each(keys)("moves when %s changes, unless the design excludes it", (key) => {
    expect(moves(key)).toBe(!excluded.includes(key));
  });
});

describe("locations inside hashed fields", () => {
  it("leaves a case's fixture path out but not its tree hash", () => {
    const evalCase = readFixtureObject("cases/standup-note.json");
    const tree = { kind: "tree", path: "fixtures/a", treeSha256: "a".repeat(64) };

    const base = caseHash(unvalidated<EvalCase>({ ...evalCase, fixture: tree }));

    expect(caseHash(unvalidated<EvalCase>({ ...evalCase, fixture: { ...tree, path: "fixtures/b" } }))).toBe(base);
    expect(caseHash(unvalidated<EvalCase>({ ...evalCase, fixture: { ...tree, treeSha256: "b".repeat(64) } }))).not.toBe(base);
  });

  it("leaves a variant's topology module path out but not its source hash", () => {
    const variant = readFixtureObject("variants/single-pass.json");
    const topology = asRecord(variant.topology);
    const base = variantHash(unvalidated<VariantSpec>(variant));

    expect(variantHash(unvalidated<VariantSpec>({ ...variant, topology: { ...topology, module: "elsewhere.ts" } }))).toBe(base);
    expect(variantHash(unvalidated<VariantSpec>({ ...variant, topology: { ...topology, sourceSha256: "c".repeat(64) } }))).not.toBe(base);
  });
});

describe("references to other specs", () => {
  const variant = readFixtureObject("variants/single-pass.json");
  const childRef = { id: "child-unit", version: "1.0.0" };
  const withChild = (child: unknown) => ({ ...variant, steps: { ...asRecord(variant.steps), delegate: { kind: "unit", unit: childRef, variant: child } } });

  it("moves a parent variant's hash when its pinned child variant changes", () => {
    expect(variantHash(unvalidated<VariantSpec>(withChild("d".repeat(64))))).not.toBe(variantHash(unvalidated<VariantSpec>(withChild("e".repeat(64)))));
  });

  it.each([
    ["a child variant named by id", { kind: "unit", unit: childRef, variant: "fast" }],
    ["a child unit with no version", { kind: "unit", unit: "child-unit", variant: "d".repeat(64) }],
  ])("refuses %s, which a hash could not follow", (_label, step) => {
    expect(() => parseSpec({ ...variant, steps: { delegate: step } })).toThrow();
  });

  it("accepts a child variant pinned by content hash or resolved as the champion at trial start", () => {
    expect(() => parseSpec(withChild("d".repeat(64)))).not.toThrow();
    expect(() => parseSpec(withChild("champion"))).not.toThrow();
  });

  it("moves a case's hash when it changes split, because the suite lists cases by hash alone", () => {
    const evalCase = readFixtureObject("cases/standup-note.json");

    expect(caseHash(unvalidated<EvalCase>({ ...evalCase, split: "holdout" }))).not.toBe(caseHash(unvalidated<EvalCase>(evalCase)));
  });
});
