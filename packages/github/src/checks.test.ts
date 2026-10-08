import { describe, expect, it } from "vitest";
import { isPassing, latestPerName } from "./checks.js";
import { successRun } from "./fake.js";

describe("latestPerName", () => {
  it("a later cancelled run supersedes an earlier success for the same name", () => {
    const runs = [successRun("validate", 1, "2026-01-01T00:00:00Z"), successRun("validate", 2, "2026-01-01T00:05:00Z", "cancelled"), successRun("dag-check", 3)];

    expect(latestPerName(runs).map((run) => [run.name, run.conclusion])).toEqual([["validate", "cancelled"], ["dag-check", "success"]]);
  });

  it("a later success supersedes an earlier cancelled run, whatever order the API lists them in", () => {
    const runs = [successRun("validate", 2, "2026-01-01T00:05:00Z"), successRun("validate", 1, "2026-01-01T00:00:00Z", "cancelled")];

    expect(latestPerName(runs).map((run) => run.id)).toEqual([2]);
  });

  it("an empty list stays empty", () => {
    expect(latestPerName([])).toEqual([]);
  });
});

describe("isPassing", () => {
  it("a run still in progress is not passing even if it reports success", () => {
    expect(isPassing({ ...successRun("validate", 1), status: "in_progress" })).toBe(false);
  });

  it("a cancelled run is not passing", () => {
    expect(isPassing(successRun("validate", 1, undefined, "cancelled"))).toBe(false);
  });
});
