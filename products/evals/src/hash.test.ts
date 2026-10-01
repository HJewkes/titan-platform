import { describe, expect, it } from "vitest";
import { canonicalJson, caseHash, hashCanonical, pinVariantPrompts, suiteHash, unitHash, variantHash } from "./hash.js";
import { readFixture } from "./test-fixtures.js";
import type { EvalCase, SuiteSpec, UnitSpec, VariantSpec } from "./spec/index.js";

function reversedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reversedKeys);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reversedKeys(item)]));
}

function promptReader(files: Record<string, string>) {
  return async (path: string) => {
    const content = files[path];
    if (content === undefined) throw new Error(`no prompt at ${path}`);
    return content;
  };
}

describe("canonical hashing", () => {
  it("gives the same hash when the same object is hashed twice", () => {
    const unit = readFixture<UnitSpec>("unit.json");

    expect(unitHash(unit)).toBe(unitHash(unit));
  });

  it("gives the same hash after every key is reordered", () => {
    const unit = readFixture<UnitSpec>("unit.json");
    const reordered = reversedKeys(unit) as UnitSpec;

    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(unit));
    expect(unitHash(reordered)).toBe(unitHash(unit));
  });

  it("emits sorted keys with no whitespace and drops undefined members", () => {
    expect(canonicalJson({ b: [2, { d: 1, c: undefined }], a: "x" })).toBe('{"a":"x","b":[2,{"d":1}]}');
  });

  it("refuses values that do not survive a JSON round trip", () => {
    expect(() => hashCanonical({ at: new Date(0) })).toThrow(/JSON/);
    expect(() => hashCanonical({ n: Number.NaN })).toThrow(/JSON/);
  });

  it("keeps array order, because a step list or criteria list is ordered", () => {
    expect(hashCanonical([1, 2])).not.toBe(hashCanonical([2, 1]));
  });
});

describe("what each hash covers", () => {
  it("ignores a unit's title and description but not its objective", () => {
    const unit = readFixture<UnitSpec>("unit.json");
    const retitled = { ...unit, title: "Another title", description: "Reworded." };
    const reranked = { ...unit, objective: { ...unit.objective, primary: { name: "brevity", direction: "minimize" as const } } };

    expect(unitHash(retitled)).toBe(unitHash(unit));
    expect(unitHash(reranked)).not.toBe(unitHash(unit));
  });

  it("ignores a case's tags and provenance source but not its gold label or label version", () => {
    const evalCase = readFixture<EvalCase>("cases/standup-note.json");
    const retagged = { ...evalCase, tags: ["other"], provenance: { ...evalCase.provenance, source: "contributed" as const } };
    const relabelled = { ...evalCase, provenance: { ...evalCase.provenance, labelVersion: 2 } };
    const regolded = { ...evalCase, expected: { actionItems: [] } };

    expect(caseHash(retagged)).toBe(caseHash(evalCase));
    expect(caseHash(relabelled)).not.toBe(caseHash(evalCase));
    expect(caseHash(regolded)).not.toBe(caseHash(evalCase));
  });

  it("ignores a suite's id and version text and the order its cases are listed in", () => {
    const suite = readFixture<SuiteSpec>("suite.json");
    const renamed = { ...suite, id: "renamed", version: "9.9.9", cases: [...suite.cases].reverse() };

    expect(suiteHash(renamed)).toBe(suiteHash(suite));
    expect(suiteHash({ ...suite, trials: 5 })).not.toBe(suiteHash(suite));
  });

  it("ignores a variant's notes and parents but not its model", () => {
    const variant = readFixture<VariantSpec>("variants/single-pass.json");
    const annotated = { ...variant, notes: "Another hypothesis.", parents: ["a".repeat(64)] };
    const step = variant.steps.summarize as Extract<VariantSpec["steps"][string], { kind: "llm" }>;
    const remodelled = { ...variant, steps: { summarize: { ...step, model: "claude-opus-5-5" } } };

    expect(variantHash(annotated)).toBe(variantHash(variant));
    expect(variantHash(remodelled)).not.toBe(variantHash(variant));
  });
});

describe("variant prompt pinning", () => {
  const variant = readFixture<VariantSpec>("variants/single-pass.json");

  it("changes the variant hash when a referenced prompt file changes", async () => {
    const before = await pinVariantPrompts(variant, promptReader({ "prompts/summarize.md": "Summarize {{note}}." }));
    const after = await pinVariantPrompts(variant, promptReader({ "prompts/summarize.md": "Summarize {{note}} in one line." }));

    expect(variantHash(after)).not.toBe(variantHash(before));
  });

  it("keeps the variant hash when the prompt file moves but its content does not", async () => {
    const content = "Summarize {{note}}.";
    const step = variant.steps.summarize as Extract<VariantSpec["steps"][string], { kind: "llm" }>;
    const moved = { ...variant, steps: { summarize: { ...step, prompt: { ...step.prompt, path: "prompts/moved.md" } } } };

    const original = await pinVariantPrompts(variant, promptReader({ "prompts/summarize.md": content }));
    const relocated = await pinVariantPrompts(moved, promptReader({ "prompts/moved.md": content }));

    expect(variantHash(relocated)).toBe(variantHash(original));
  });
});
