import { describe, expect, it } from "vitest";
import type { PlannerRun } from "./inputs.js";
import { ghWindow } from "./window-ports.js";

const SINCE = "2026-01-02T03:00:00.000Z";
const AFTER = "2026-01-02T03:30:00.000Z";

const RUNS_BY_STATUS: Record<string, { databaseId: number; workflowName: string; createdAt: string }[]> = {
  failure: [{ databaseId: 1, workflowName: "CI", createdAt: AFTER }],
  timed_out: [{ databaseId: 2, workflowName: "Release", createdAt: AFTER }],
  startup_failure: [{ databaseId: 3, workflowName: "Docs", createdAt: AFTER }],
  success: [{ databaseId: 4, workflowName: "CI", createdAt: AFTER }],
  cancelled: [{ databaseId: 5, workflowName: "CI", createdAt: AFTER }],
};

describe("redMainRuns", () => {
  it("counts failure, timed_out and startup_failure runs and leaves success and cancelled out", async () => {
    const statuses: string[] = [];
    const gh: PlannerRun = async (_file, args) => {
      const status = args[args.indexOf("--status") + 1] ?? "";
      statuses.push(status);
      return { code: 0, stdout: JSON.stringify(RUNS_BY_STATUS[status] ?? []), stderr: "" };
    };

    const red = await ghWindow(gh).redMainRuns("org/repo", SINCE);

    expect(red.map((r) => r.id).sort()).toEqual([1, 2, 3]);
    expect(statuses).not.toContain("success");
    expect(statuses).not.toContain("cancelled");
  });
});
