import { describe, expect, it } from "vitest";
import { isConcluded, isPassing, isSucceeded } from "./checks.js";
import { fakeSha } from "./fake.js";
import type { CommitStatus } from "./port.js";
import { GITHUB_ACTIONS_APP_ID, headCheckFindings } from "./readiness.js";
import { statusCheckRuns } from "./status-runs.js";

const HEAD = fakeSha("status-head");
const GATE = "local-gate";
const status = (state: string, context = GATE): CommitStatus => ({ context, state, targetUrl: "https://ci.example/run/1", description: "gate", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:05:00Z" });
const findingKinds = (statuses: CommitStatus[]) => headCheckFindings({ headSha: HEAD, contexts: [GATE], runs: statusCheckRuns(statuses, HEAD, [GATE]), requiredApps: [GITHUB_ACTIONS_APP_ID] }).map((finding) => finding.kind);

describe("statusCheckRuns", () => {
  it("stands a success status in as a succeeded Actions run at the head", () => {
    const [run] = statusCheckRuns([status("success")], HEAD, [GATE]);

    expect(run).toMatchObject({ name: GATE, headSha: HEAD, appId: GITHUB_ACTIONS_APP_ID, workflowRunId: null, url: "https://ci.example/run/1", completedAt: "2026-01-01T00:05:00Z" });
    expect(run !== undefined && isSucceeded(run)).toBe(true);
  });

  it("reads a pending status as a run still going", () => {
    const [run] = statusCheckRuns([status("pending")], HEAD, [GATE]);

    expect(run !== undefined && isConcluded(run)).toBe(false);
  });

  it.each(["failure", "error"])("reads a %s status as a run that concluded red", (state) => {
    const [run] = statusCheckRuns([status(state)], HEAD, [GATE]);

    expect(run !== undefined && isConcluded(run) && !isPassing(run)).toBe(true);
  });

  it("reads a named context with no status as a queued run, so it never counts as passed", () => {
    expect(statusCheckRuns([status("success", "other")], HEAD, [GATE])).toEqual([expect.objectContaining({ name: GATE, status: "queued", conclusion: null, startedAt: null })]);
  });

  it("ignores statuses whose context is not named", () => {
    expect(statusCheckRuns([status("failure", "other")], HEAD, [])).toEqual([]);
  });

  it("gives each context its own negative id", () => {
    expect(statusCheckRuns([], HEAD, ["a", "b", "a"]).map((run) => run.id)).toEqual([-1, -2]);
  });

  it("feeds the shared head judge: success green, pending pending, failure failed, missing pending", () => {
    expect([findingKinds([status("success")]), findingKinds([status("pending")]), findingKinds([status("failure")]), findingKinds([])]).toEqual([[], ["pending"], ["failed"], ["pending"]]);
  });
});
