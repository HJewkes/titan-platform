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

describe("strictness inside nested refs", () => {
  it("rejects an unknown key inside a prompt ref when strict and keeps it when loose", () => {
    const variant = readFixture<VariantSpec>("variants/single-pass.json");
    const step = variant.steps.summarize as Extract<VariantSpec["steps"][string], { kind: "llm" }>;
    const extended = { ...variant, steps: { summarize: { ...step, prompt: { ...step.prompt, encoding: "utf8" } } } };

    expect(() => parseSpec(extended, "strict")).toThrow(/encoding|Unrecognized/);
    expect(parseSpec(extended, "loose")).toMatchObject({ steps: { summarize: { prompt: { encoding: "utf8" } } } });
  });

  it("rejects an unknown key inside a judge when strict and keeps it when loose", () => {
    const suite = readFixture<{ checks: Record<string, unknown>[] }>("suite.json");
    const judge = suite.checks.find((check) => check.family === "judge") as { judge: Record<string, unknown> };
    const extended = { ...suite, checks: [{ ...judge, judge: { ...judge.judge, temperature: 0 } }] };

    expect(() => parseSpec(extended, "strict")).toThrow(/temperature|Unrecognized/);
    expect(parseSpec(extended, "loose")).toMatchObject({ checks: [{ judge: { temperature: 0 } }] });
  });
});

describe("model ids", () => {
  const strictModel = (model: string) => () =>
    parseSpec(withLlmModel(readFixture<VariantSpec>("variants/single-pass.json"), model), "strict");

  it.each([
    ["a bare alias", "sonnet"],
    ["a bare alias with a 1m suffix", "sonnet[1m]"],
    ["a bare alias without a digit", "opus"],
    ["mixed case", "Claude-Opus-5-5"],
    ["a leading space", " sonnet"],
    ["an id containing a space", "claude opus-5-5"],
    ["a trailing space", "claude-opus-5-5 "],
    ["a -latest tag", "claude-sonnet-latest"],
    ["a -latest tag with a 1m suffix", "claude-sonnet-latest[1m]"],
    ["a 1m suffix in the middle", "claude-opus-5-5[1m]-x"],
    ["a 1m suffix at the start", "[1m]claude-opus-5-5"],
    ["an alias with a Vertex version", "opus@1"],
    ["an alias with a Bedrock version", "sonnet:1"],
    ["an alias with a Vertex version and a 1m suffix", "opus@20260101[1m]"],
    ["a -latest tag with a Vertex version", "claude-sonnet-latest@20260101"],
    ["a -latest tag with a Bedrock version", "claude-sonnet-latest:0"],
    ["a Vertex and a Bedrock version together", "claude-opus-5-5@x:y"],
    ["a doubled 1m suffix", "claude-opus-5-5[1m][1m]"],
  ])("refuses %s on write", (_form, model) => {
    expect(strictModel(model)).toThrow(/model/);
  });

  it.each([
    ["an exact id", "claude-opus-5-5"],
    ["an exact id with a 1m suffix", "claude-opus-5-5[1m]"],
    ["a dated id", "claude-haiku-4-5-20251001"],
    ["a non-Anthropic id", "gpt-5-codex"],
    ["a Vertex id with @", "claude-opus-5-5@20260101"],
    ["a Vertex id with @ and a 1m suffix", "claude-opus-5-5@20260101[1m]"],
    ["a Bedrock id with :", "anthropic.claude-opus-5-5-v1:0"],
    ["a region-prefixed Bedrock id", "us.anthropic.claude-opus-5-5-v1:0"],
  ])("accepts %s", (_form, model) => {
    expect(strictModel(model)).not.toThrow();
  });
});
