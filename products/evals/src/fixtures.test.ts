import { readFile } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { caseHash, judgesHash, pinSuitePrompts, suiteHash, unitHash, variantHash } from "./hash.js";
import { parseSpec } from "./spec/index.js";
import type { EvalCase, Scorecard, SuiteSpec, UnitSpec, VariantSpec } from "./spec/index.js";
import { FIXTURE_ROOT, readFixture } from "./test-fixtures.js";
import { validateSpec } from "./validate.js";

const readFromFixtures = (path: string) => readFile(`${FIXTURE_ROOT}${path}`);

describe("the summarize-note fixture set", () => {
  const unit = parseSpec(readFixture("unit.json")) as UnitSpec;
  const variant = parseSpec(readFixture("variants/single-pass.json")) as VariantSpec;
  const suite = parseSpec(readFixture("suite.json")) as SuiteSpec;
  const scorecard = parseSpec(readFixture("scorecard.json")) as Scorecard;
  const cases = readdirSync(`${FIXTURE_ROOT}cases`).map((file) => parseSpec(readFixture(`cases/${file}`)) as EvalCase);

  it("lists exactly the hashes of the shipped cases, sorted", () => {
    expect(suite.cases).toEqual(cases.map(caseHash).sort());
  });

  it("covers every split once", () => {
    expect(cases.map((evalCase) => evalCase.split).sort()).toEqual(["dev", "holdout", "validation"]);
  });

  it("keys its scorecard by the unit, variant, suite and judge hashes", () => {
    expect(scorecard.keys).toMatchObject({
      unit: unitHash(unit),
      variant: variantHash(variant),
      suite: suiteHash(suite),
      judges: judgesHash(suite),
    });
  });

  it.each(["variants/single-pass.json", "suite.json"])("stores current prompt digests in %s", async (file) => {
    const result = await validateSpec(readFixture(file), readFromFixtures);

    expect(result.stalePrompts).toBe(false);
  });

  it("is all synthetic and public", () => {
    for (const evalCase of cases) expect(evalCase.provenance.source).toBe("synthetic");
    expect([unit.visibility, ...cases.map((evalCase) => evalCase.visibility)]).not.toContain("private");
  });
});

describe("validateSpec", () => {
  it("flags a variant whose prompt file changed after its digest was stored", async () => {
    const result = await validateSpec(readFixture("variants/single-pass.json"), async () => "an edited prompt");

    expect(result.stalePrompts).toBe(true);
    expect(result.hash).not.toBe(variantHash(parseSpec(readFixture("variants/single-pass.json")) as VariantSpec));
  });

  it("hashes a scorecard by its key, ignoring the environment fingerprint", async () => {
    const scorecard = readFixture<Scorecard>("scorecard.json");
    const otherHost = { ...scorecard, keys: { ...scorecard.keys, env: { ...scorecard.keys.env, os: "darwin-arm64" } } };

    const [here, there] = await Promise.all([validateSpec(scorecard, readFromFixtures), validateSpec(otherHost, readFromFixtures)]);

    expect(there.hash).toBe(here.hash);
  });
});

describe("judge prompt pinning", () => {
  const suite = parseSpec(readFixture("suite.json")) as SuiteSpec;

  it("moves the suite and judge hashes when the judge prompt file changes", async () => {
    const before = await pinSuitePrompts(suite, async () => "Grade the summary.");
    const after = await pinSuitePrompts(suite, async () => "Grade the summary strictly.");

    expect(suiteHash(after)).not.toBe(suiteHash(before));
    expect(judgesHash(after)).not.toBe(judgesHash(before));
  });

  it("reports a suite stale when its judge prompt changed after the digest was stored", async () => {
    const result = await validateSpec(readFixture("suite.json"), async () => "an edited judge prompt");

    expect(result.stalePrompts).toBe(true);
  });
});
