import { describe, expect, it } from "vitest";
import { planFixProof, testOnlyOf, testOnlyReading, type FixProofPlan, type PlanInput } from "./plan.js";

function plan(input: PlanInput): FixProofPlan {
  const result = planFixProof(input);
  if (!result.ok) throw new Error(result.error);
  return result.plan;
}

const diff = (...lines: string[]) => lines.join("\n") + "\n";

describe("planFixProof", () => {
  it("selects added and modified tests and carries only fixture-like files", () => {
    const result = plan({
      nameStatus: diff(
        "M\tsrc/parse.ts",
        "A\tsrc/parse.test.ts",
        "M\tlib/util.spec.mjs",
        "A\tsrc/fixtures/input.json",
        "A\tsrc/test-support/helpers.ts",
        "A\tsrc/helpers.ts",
      ),
    });

    expect(result.tests).toEqual(["lib/util.spec.mjs", "src/parse.test.ts"]);
    expect(result.carried).toEqual(["src/fixtures/input.json", "src/test-support/helpers.ts"]);
  });

  it("treats a pure R100 test rename as no test at all", () => {
    const result = plan({ nameStatus: diff("M\tsrc/parse.ts", "R100\tsrc/old.test.ts\tsrc/new.test.ts") });

    expect(result.tests).toEqual([]);
    expect(result.overlayRemovals).toEqual([]);
    expect(result.deletedTests).toEqual([]);
  });

  it("runs the new path of a partial rename and removes the old path from the overlay", () => {
    const result = plan({ nameStatus: diff("R087\tsrc/old.test.ts\tsrc/new.test.ts") });

    expect(result.tests).toEqual(["src/new.test.ts"]);
    expect(result.overlayRemovals).toEqual(["src/old.test.ts"]);
  });

  it("records deleted tests without running them", () => {
    const result = plan({ nameStatus: diff("D\tsrc/gone.test.ts", "D\tsrc/gone.ts") });

    expect(result.tests).toEqual([]);
    expect(result.deletedTests).toEqual(["src/gone.test.ts"]);
  });

  it("records a test renamed out of the test globs as deleted", () => {
    const result = plan({ nameStatus: diff("R100\tsrc/a.test.ts\tsrc/a.ts") });

    expect(result.deletedTests).toEqual(["src/a.test.ts"]);
    expect(result.tests).toEqual([]);
  });

  it("reads test globs from the base config even when the head config widens them", () => {
    const baseConfig = JSON.stringify({ tests: ["**/*.test.ts"] });
    const headConfig = JSON.stringify({ tests: ["**/*.ts"] });

    const result = plan({
      nameStatus: diff("M\t.github/fix-proof.json", "A\tsrc/fix.ts", "A\tsrc/fix.test.ts"),
      baseConfig,
      headConfig,
    });

    expect(result.tests).toEqual(["src/fix.test.ts"]);
    expect(result.config.tests).toEqual(["**/*.test.ts"]);
    expect(result.configEdited).toBe(true);
  });

  it("uses the defaults when the base has no config, even if head adds one", () => {
    const result = plan({
      nameStatus: diff("A\t.github/fix-proof.json", "A\tsrc/fix.ts"),
      baseConfig: null,
      headConfig: JSON.stringify({ tests: ["src/**"] }),
    });

    expect(result.tests).toEqual([]);
    expect(result.configEdited).toBe(true);
  });

  it("reports an unedited config as unedited", () => {
    const config = JSON.stringify({ carry: ["**/golden/**"] });

    const result = plan({ nameStatus: diff("A\tsrc/golden/out.txt"), baseConfig: config, headConfig: config });

    expect(result.carried).toEqual(["src/golden/out.txt"]);
    expect(result.configEdited).toBe(false);
  });

  it.each([
    ["an unmerged status", "U\tsrc/a.test.ts"],
    ["a quoted path", 'A\t"src/t\\tab.test.ts"'],
    ["a path escaping the repo", "A\t../outside.test.ts"],
    ["an absolute path", "A\t/etc/a.test.ts"],
    ["a rename missing its new path", "R090\tsrc/a.test.ts"],
    ["a similarity over 100", "R101\tsrc/a.test.ts\tsrc/b.test.ts"],
  ])("refuses a diff with %s", (_label, line) => {
    expect(planFixProof({ nameStatus: diff(line) }).ok).toBe(false);
  });

  it.each([
    ["malformed JSON", "{"],
    ["an unknown key", JSON.stringify({ test: ["**"] })],
    ["a non-array glob list", JSON.stringify({ tests: "**/*.test.ts" })],
  ])("refuses a base config with %s", (_label, baseConfig) => {
    expect(planFixProof({ nameStatus: "", baseConfig }).ok).toBe(false);
  });

  it.each(["--reporter=x.test.ts", "-t.test.ts"])("rejects a selected test whose path %s would read as a vitest flag", (test) => {
    const result = planFixProof({ nameStatus: diff(`A\t${test}`) });

    expect(result).toEqual({ ok: false, error: `unsafe test path: ${test}` });
  });

  it("plans a test with a dash inside its path", () => {
    expect(plan({ nameStatus: diff("A\tsrc/-ok.test.ts") }).tests).toEqual(["src/-ok.test.ts"]);
  });
});

describe("source and mutation buckets", () => {
  const repoConfig = JSON.stringify({
    tests: ["{packages,products,apps}/*/src/**/*.test.{ts,tsx}", "apps/*/{scripts,server}/**/*.test.ts", "scripts/**/*.test.mjs"],
    carry: ["**/fixtures/**", "**/__fixtures__/**", "**/test-support/**", "**/testdata/**", "**/*.test-helpers.ts", "**/*.fixture.ts"],
    runtime: ["packages/agent-protocol/fixtures/**", "apps/console/fixtures/**"],
  });
  const planned = (...lines: string[]) => plan({ nameStatus: diff(...lines), baseConfig: repoConfig });

  it("reads the Z7 diff, a changeset and one test, as test-only", () => {
    const result = planned("A\t.changeset/tp-2677-restart-contract.md", "A\tproducts/factory/src/restart-contract.test.ts");

    expect(result.source).toEqual([]);
    expect(testOnlyOf(result)).toBe(true);
    expect(testOnlyReading(result)).toEqual({ testOnly: true });
  });

  it("reads the Z8 diff, with test-support files, as test-only", () => {
    const result = planned(
      "A\t.changeset/z8-serve-restart-resume.md",
      "A\tproducts/factory/src/serve-restart-resume.test.ts",
      "A\tproducts/factory/src/test-support/serve-child-main.ts",
      "A\tproducts/factory/src/test-support/serve-child.ts",
    );

    expect(result.source).toEqual([]);
    expect(result.carried).toEqual(["products/factory/src/test-support/serve-child-main.ts", "products/factory/src/test-support/serve-child.ts"]);
    expect(testOnlyOf(result)).toBe(true);
    expect(testOnlyReading(result)).toEqual({ testOnly: true });
  });

  it("reads a changeset-only diff as no-tests", () => {
    expect(testOnlyReading(planned("A\t.changeset/x.md"))).toEqual({ testOnly: false, reason: "no-tests" });
  });

  it("reads a fixture-only diff as no-tests", () => {
    expect(testOnlyReading(planned("M\tpackages/pm/src/fixtures/a.json"))).toEqual({ testOnly: false, reason: "no-tests" });
  });

  it("reads a diff that adds one test and deletes another as deletes-tests", () => {
    const result = planned("A\tproducts/factory/src/a.test.ts", "D\tproducts/factory/src/b.test.ts");

    expect(testOnlyReading(result)).toEqual({ testOnly: false, reason: "deletes-tests", paths: ["products/factory/src/b.test.ts"] });
  });

  it("reads a deleted-tests-only diff as deletes-tests, not no-tests", () => {
    const result = planned("D\tproducts/factory/src/b.test.ts");

    expect(testOnlyReading(result)).toEqual({ testOnly: false, reason: "deletes-tests", paths: ["products/factory/src/b.test.ts"] });
  });

  it.each([
    ["a published agent-protocol fixture", "packages/agent-protocol/fixtures/round.json"],
    ["a console round fixture", "apps/console/fixtures/rounds/r1/round.json"],
  ])("reads %s as source while still carrying it", (_label, path) => {
    const result = planned(`M\t${path}`, "A\tproducts/factory/src/a.test.ts");

    expect(result.carried).toEqual([path]);
    expect(testOnlyReading(result)).toEqual({ testOnly: false, reason: "source", paths: [path] });
  });

  it("puts changed and deleted non-test files in source", () => {
    const result = planned("M\tproducts/factory/src/serve.ts", "D\tpackages/store/src/old.ts", "A\tproducts/factory/src/serve.test.ts");

    expect(result.source).toEqual(["packages/store/src/old.ts", "products/factory/src/serve.ts"]);
    expect(testOnlyOf(result)).toBe(false);
  });

  it("puts the old path of a rename into a test in source", () => {
    const result = planned("R100\tproducts/factory/src/x.ts\tproducts/factory/src/x.test.ts");

    expect(result.source).toEqual(["products/factory/src/x.ts"]);
  });

  it("puts the new path of a rename out of the tests in source", () => {
    expect(planned("R090\tproducts/factory/src/x.test.ts\tproducts/factory/src/x.ts").source).toEqual(["products/factory/src/x.ts"]);
  });

  it("leaves the untouched old path of a copy out of source", () => {
    const result = planned("C100\tproducts/factory/src/x.ts\tproducts/factory/src/test-support/x.ts");

    expect(result.source).toEqual([]);
  });

  it("collects added and changed mutation specs, not deleted ones, and keeps them out of carried and source", () => {
    const result = planned(
      "A\tproducts/factory/src/serve.test.mutations.json",
      "M\tproducts/factory/src/fixtures/a.mutations.json",
      "D\tproducts/factory/src/gone.test.mutations.json",
    );

    expect(result.mutations).toEqual(["products/factory/src/fixtures/a.mutations.json", "products/factory/src/serve.test.mutations.json"]);
    expect(result.carried).toEqual([]);
    expect(result.source).toEqual([]);
  });

  it("counts a harness path as source even where a carry glob matches it", () => {
    const result = planned("A\t.github/workflows/fixtures/x.yml", "M\tscripts/fix-proof-run.sh", "M\t.github/fix-proof.json");

    expect(result.source).toEqual([".github/fix-proof.json", ".github/workflows/fixtures/x.yml", "scripts/fix-proof-run.sh"]);
  });

  it("counts docs, configs and nested changeset paths as source", () => {
    const result = planned("M\tREADME.md", "M\tvitest.config.ts", "A\t.changeset/deep/x.md", "A\t.changeset/config.json");

    expect(result.source).toEqual([".changeset/config.json", ".changeset/deep/x.md", "README.md", "vitest.config.ts"]);
  });
});
