import { describe, expect, it } from "vitest";
import { planFixProof, type FixProofPlan, type PlanInput } from "./plan.js";

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
});
