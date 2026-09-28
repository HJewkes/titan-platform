import { describe, expect, it } from "vitest";
import { evaluateChecks, latestPerName } from "./checks.js";
import { successRun } from "./fake.js";

const REQUIRED = ["validate", "dag-check"];

describe("required checks on one head", () => {
  it("a success followed by a later cancelled run for validate reads as not passed", () => {
    const runs = [successRun("validate", 1, "2026-01-01T00:00:00Z"), successRun("validate", 2, "2026-01-01T00:05:00Z", "cancelled"), successRun("dag-check", 3)];

    const verdict = evaluateChecks(REQUIRED, latestPerName(runs));

    expect(verdict.state).toBe("failed");
    expect(verdict.failing.map((run) => [run.name, run.conclusion])).toEqual([["validate", "cancelled"]]);
  });

  it("a later success supersedes an earlier cancelled run, whatever order the API lists them in", () => {
    const runs = [successRun("validate", 2, "2026-01-01T00:05:00Z"), successRun("validate", 1, "2026-01-01T00:00:00Z", "cancelled"), successRun("dag-check", 3)];

    expect(evaluateChecks(REQUIRED, latestPerName(runs)).state).toBe("passed");
  });

  it("an empty rollup reads pending, never passed", () => {
    expect(evaluateChecks(REQUIRED, [])).toEqual({ state: "pending", pending: REQUIRED, failing: [] });
  });

  it("a required check still running reads pending even when the others passed", () => {
    const running = { ...successRun("dag-check", 3), status: "in_progress", conclusion: null };

    expect(evaluateChecks(REQUIRED, latestPerName([successRun("validate", 1), running]))).toMatchObject({ state: "pending", pending: ["dag-check"] });
  });

  it("checks that are not required do not decide the verdict", () => {
    const runs = [successRun("validate", 1), successRun("dag-check", 2), successRun("deploy", 3, undefined, "failure")];

    expect(evaluateChecks(REQUIRED, latestPerName(runs)).state).toBe("passed");
  });
});
