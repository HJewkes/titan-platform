import { describe, expect, it } from "vitest";
import { readFixture } from "../test-fixtures.js";
import { parseSpec } from "./index.js";
import type { VariantSpec } from "./index.js";

const FIXTURES = [
  "unit.json",
  "variants/single-pass.json",
  "cases/standup-note.json",
  "cases/no-actions.json",
  "cases/long-planning-note.json",
  "suite.json",
  "scorecard.json",
];

function withLlmModel(variant: VariantSpec, model: string): unknown {
  const step = variant.steps.summarize as Extract<VariantSpec["steps"][string], { kind: "llm" }>;
  return { ...variant, steps: { summarize: { ...step, model } } };
}

describe("spec round trip", () => {
  it.each(FIXTURES)("parses %s strictly and re-parses its serialized form unchanged", (file) => {
    const parsed = parseSpec(readFixture(file));

    const reparsed = parseSpec(JSON.parse(JSON.stringify(parsed)));

    expect(reparsed).toEqual(parsed);
  });

  it("fills a check's scope with trial when the spec leaves it out", () => {
    const suite = readFixture<{ checks: Record<string, unknown>[] }>("suite.json");
    const unscoped = { ...suite.checks[0], scope: undefined };

    const parsed = parseSpec({ ...suite, checks: [unscoped] });

    expect(parsed).toMatchObject({ checks: [{ scope: "trial" }] });
  });
});

describe("strict and loose parsing", () => {
  it.each(FIXTURES)("rejects an unknown top-level key in %s when strict and keeps it when loose", (file) => {
    const extended = { ...readFixture<object>(file), addedLater: true };

    expect(() => parseSpec(extended, "strict")).toThrow(/addedLater|Unrecognized/);
    expect(parseSpec(extended, "loose")).toMatchObject({ addedLater: true });
  });

  it("rejects an unknown key nested in a step when strict and keeps it when loose", () => {
    const variant = readFixture<VariantSpec>("variants/single-pass.json");
    const nested = { ...variant, steps: { summarize: { ...variant.steps.summarize, temperature: 0 } } };

    expect(() => parseSpec(nested, "strict")).toThrow();
    expect(parseSpec(nested, "loose")).toMatchObject({ steps: { summarize: { temperature: 0 } } });
  });

  it("refuses a model alias on write and reads it back when loose", () => {
    const aliased = withLlmModel(readFixture<VariantSpec>("variants/single-pass.json"), "sonnet");

    expect(() => parseSpec(aliased, "strict")).toThrow(/alias/);
    expect(parseSpec(aliased, "loose")).toMatchObject({ steps: { summarize: { model: "sonnet" } } });
  });

  it("still validates known fields when loose", () => {
    const unit = { ...readFixture<object>("unit.json"), id: "Not Kebab" };

    expect(() => parseSpec(unit, "loose")).toThrow();
  });

  it.each(["/srv/prompts/a.md", "~/prompts/a.md", "../outside.md", "C:/prompts/a.md"])(
    "refuses the prompt path %s so a spec never names a machine path",
    (path) => {
      const variant = readFixture<VariantSpec>("variants/single-pass.json");
      const step = variant.steps.summarize as Extract<VariantSpec["steps"][string], { kind: "llm" }>;
      const moved = { ...variant, steps: { summarize: { ...step, prompt: { ...step.prompt, path } } } };

      expect(() => parseSpec(moved)).toThrow(/path/);
    },
  );

  it("names the expected schemas when a spec's schema field is unknown", () => {
    expect(() => parseSpec({ schema: "titan.unit/v9" })).toThrow(/titan\.unit\/v1/);
    expect(() => parseSpec(null)).toThrow(/unknown spec schema/);
  });
});

describe("schema edges", () => {
  it("requires a case's input even though any JSON value is allowed", () => {
    const evalCase = { ...readFixture<Record<string, unknown>>("cases/standup-note.json"), input: undefined };

    expect(() => parseSpec(evalCase)).toThrow(/input/);
  });

  it("refuses a backslash path, which is one file name on POSIX and a folder path on Windows", () => {
    const variant = readFixture<VariantSpec>("variants/single-pass.json");
    const step = variant.steps.summarize as Extract<VariantSpec["steps"][string], { kind: "llm" }>;
    const moved = { ...variant, steps: { summarize: { ...step, prompt: { ...step.prompt, path: "prompts\\summarize.md" } } } };

    expect(() => parseSpec(moved)).toThrow(/forward slashes/);
  });
});
