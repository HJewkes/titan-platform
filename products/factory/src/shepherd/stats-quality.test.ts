import type { WorkflowRun } from "@titan-design/workflow";
import { describe, expect, it } from "vitest";
import { redAfterMerge } from "./stats-quality.js";

const DAY = 86_400_000;
const T0 = Date.parse("2026-09-15T10:00:00Z");
const iso = (at: number): string => new Date(at).toISOString();

function run(pr: number, reads: [number, "green" | "red"][], repo = "Acme/Widgets"): WorkflowRun {
  const stepResults = Object.fromEntries(reads.map(([at, verdict], i) => [`sh-main-ci:${i}`, { stepId: "sh-main-ci", iteration: i, agentId: null, signal: null, completedAt: iso(at), data: { result: { verdict } } }]));
  return { id: `run-${pr}`, workflowName: "shepherd-pr", params: { repo, pr: String(pr) }, status: "completed", currentStep: null, stepResults, activeSteps: {}, revision: 0, ownerGeneration: 0, startedAt: iso(T0), completedAt: iso(T0), error: null };
}

describe("redAfterMerge", () => {
  it("splits rows by repo and ISO week, and leaves out a run that never read main CI", () => {
    const rows = redAfterMerge([run(1, [[T0, "red"]]), run(2, [[T0 + 7 * DAY, "green"]]), run(3, []), run(4, [[T0, "green"]], "acme/other")]);

    expect(rows.map(({ repo, week, merged, red, redPrs }) => ({ repo, week, merged, red, redPrs }))).toEqual([
      { repo: "acme/other", week: "2026-W38", merged: 1, red: 0, redPrs: [] },
      { repo: "acme/widgets", week: "2026-W38", merged: 1, red: 1, redPrs: [1] },
      { repo: "acme/widgets", week: "2026-W39", merged: 1, red: 0, redPrs: [] },
    ]);
  });

  it("counts a run's last main CI read, the one it acted on", () => {
    expect(redAfterMerge([run(1, [[T0, "red"], [T0 + 60_000, "green"]])])[0]).toMatchObject({ merged: 1, red: 0, rate: 0 });
  });

  it("keeps only reads inside the range", () => {
    expect(redAfterMerge([run(1, [[T0, "red"]]), run(2, [[T0 + 7 * DAY, "red"]])], { from: "2026-09-20" })).toMatchObject([{ week: "2026-W39", redPrs: [2] }]);
  });
});
