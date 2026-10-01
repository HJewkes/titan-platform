import { describe, expect, it } from "vitest";
import { caseHash, scorecardKeyHash, suiteHash, unitHash, variantHash } from "./hash.js";
import { EvalCaseSchema, ScorecardSchema, SuiteSpecSchema, UnitSpecSchema, VariantSpecSchema } from "./spec/index.js";
import { readFixture } from "./test-fixtures.js";

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
  fixture: Record<string, unknown>;
  hash: (spec: never) => string;
  /** The fields the design leaves out of identity; any other schema field must move the hash. */
  excluded: string[];
}

const scorecard = readFixture<{ keys: Record<string, unknown> }>("scorecard.json");

const COVERAGE: Coverage[] = [
  { name: "unit", keys: Object.keys(UnitSpecSchema.shape), fixture: readFixture("unit.json"), hash: unitHash, excluded: ["title", "description", "acceptance", "visibility"] },
  {
    name: "case", keys: Object.keys(EvalCaseSchema.shape), fixture: readFixture("cases/standup-note.json"), hash: caseHash,
    excluded: ["id", "unit", "split", "tags", "humanMinutes", "solvable", "visibility"],
  },
  { name: "variant", keys: Object.keys(VariantSpecSchema.shape), fixture: readFixture("variants/single-pass.json"), hash: variantHash, excluded: ["id", "notes", "parents"] },
  { name: "suite", keys: Object.keys(SuiteSpecSchema.shape), fixture: readFixture("suite.json"), hash: suiteHash, excluded: ["id", "version"] },
  { name: "scorecard key", keys: Object.keys(ScorecardSchema.shape.keys.shape), fixture: scorecard.keys, hash: scorecardKeyHash, excluded: ["env"] },
];

describe.each(COVERAGE)("the $name hash", ({ keys, fixture, hash, excluded }) => {
  it("names only real schema fields as excluded", () => {
    expect(keys).toEqual(expect.arrayContaining(excluded));
  });

  it.each(keys)("moves when %s changes, unless the design excludes it", (key) => {
    const changed = { ...fixture, [key]: mutate(fixture[key]) };

    const moved = hash(changed as never) !== hash(fixture as never);

    expect(moved).toBe(!excluded.includes(key));
  });
});

describe("locations inside hashed fields", () => {
  it("leaves a case's fixture path out but not its tree hash", () => {
    const evalCase = readFixture<Record<string, unknown>>("cases/standup-note.json");
    const tree = { kind: "tree", path: "fixtures/a", treeSha256: "a".repeat(64) };

    const base = caseHash({ ...evalCase, fixture: tree } as never);

    expect(caseHash({ ...evalCase, fixture: { ...tree, path: "fixtures/b" } } as never)).toBe(base);
    expect(caseHash({ ...evalCase, fixture: { ...tree, treeSha256: "b".repeat(64) } } as never)).not.toBe(base);
  });

  it("leaves a variant's topology module path out but not its source hash", () => {
    const variant = readFixture<{ topology: Record<string, string> }>("variants/single-pass.json");
    const base = variantHash(variant as never);

    expect(variantHash({ ...variant, topology: { ...variant.topology, module: "elsewhere.ts" } } as never)).toBe(base);
    expect(variantHash({ ...variant, topology: { ...variant.topology, sourceSha256: "c".repeat(64) } } as never)).not.toBe(base);
  });
});
