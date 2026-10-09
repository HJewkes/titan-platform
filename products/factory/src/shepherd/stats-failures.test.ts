import type { WorkflowRun } from "@titan-design/workflow";
import { describe, expect, it } from "vitest";
import { failureStats, formatFailures } from "./stats-failures.js";

const CI_TIMEOUT = "step ci-wait:0 (iteration 0) failed: ci-wait timed out after 2700000 ms: waiting on check";

function runOf(id: string, error: string | null, completedAt: string | null, overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return { id, workflowName: "shepherd-pr", params: { repo: "Acme/Widgets" }, status: "failed", currentStep: null, stepResults: {}, activeSteps: {}, revision: 0, ownerGeneration: 0, startedAt: "2026-10-05T09:00:00.000Z", completedAt, error, ...overrides };
}

describe("failureStats", () => {
  it("counts failed runs per repo and ISO week under the class their prefix names", () => {
    const runs = [
      runOf("a", `[ci-timeout] ${CI_TIMEOUT}`, "2026-10-05T10:00:00.000Z"),
      runOf("b", "[land-rules] step land-rules (iteration 0) failed: refuses", "2026-10-06T10:00:00.000Z"),
      runOf("c", "[ci-timeout] whatever", "2026-10-13T10:00:00.000Z"),
    ];

    expect(failureStats(runs)).toEqual([
      { repo: "acme/widgets", week: "2026-W41", failures: 2, byClass: { "ci-timeout": 1, "gh-api-5xx": 0, "land-rules": 1, "update-branch": 0, other: 0 } },
      { repo: "acme/widgets", week: "2026-W42", failures: 1, byClass: { "ci-timeout": 1, "gh-api-5xx": 0, "land-rules": 0, "update-branch": 0, other: 0 } },
    ]);
  });

  it("classifies a legacy unprefixed row by its text", () => {
    const [row] = failureStats([runOf("a", CI_TIMEOUT, "2026-10-05T10:00:00.000Z")]);

    expect(row?.byClass["ci-timeout"]).toBe(1);
  });

  it("ignores cancelled and completed runs, and keeps a stuck run under the week it started", () => {
    const runs = [
      runOf("a", "acme/widgets#1 was merged outside Shepherd", "2026-10-05T10:00:00.000Z", { status: "cancelled" }),
      runOf("b", null, "2026-10-05T10:00:00.000Z", { status: "completed" }),
      runOf("c", "workflow returned while step ci-wait:r3:17 still required reconciliation", null, { status: "recovery_required" }),
    ];

    expect(failureStats(runs)).toEqual([{ repo: "acme/widgets", week: "2026-W41", failures: 1, byClass: { "ci-timeout": 0, "gh-api-5xx": 0, "land-rules": 0, "update-branch": 0, other: 1 } }]);
  });

  it("keeps only failures inside the date range", () => {
    const runs = [runOf("a", CI_TIMEOUT, "2026-10-05T10:00:00.000Z"), runOf("b", CI_TIMEOUT, "2026-10-13T10:00:00.000Z")];

    expect(failureStats(runs, { from: "2026-10-10" }).map((row) => row.week)).toEqual(["2026-W42"]);
  });
});

describe("formatFailures", () => {
  it("prints one line per repo and week with the classes that occurred", () => {
    const rows = failureStats([runOf("a", CI_TIMEOUT, "2026-10-05T10:00:00.000Z")]);

    expect(formatFailures(rows)).toEqual(["", "failures by class:", "acme/widgets  2026-W41  failed 1  ci-timeout 1"]);
  });

  it("prints nothing when no run failed", () => {
    expect(formatFailures([])).toEqual([]);
  });
});
