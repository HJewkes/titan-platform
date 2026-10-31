import { describe, expect, it } from "vitest";
import { isConcluded, isPassing, isPassingConclusion, isSucceeded, latestPerName } from "./checks.js";
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

  it("an equal start goes to the higher id, whatever order the API lists them in", () => {
    const low = successRun("validate", 1, "2026-01-01T00:00:00Z");
    const high = successRun("validate", 2, "2026-01-01T00:00:00Z", "failure");

    expect(latestPerName([low, high]).map((run) => run.id)).toEqual([2]);
    expect(latestPerName([high, low]).map((run) => run.id)).toEqual([2]);
  });

  it("a queued rerun with no start shadows an older success, so the stale result reads as the queued run", () => {
    const stale = successRun("validate", 2, "2026-01-01T00:05:00Z");
    const queued = { ...successRun("validate", 1), status: "queued", conclusion: null, startedAt: null };

    expect(latestPerName([stale, queued])).toEqual([queued]);
    expect(latestPerName([queued, stale])).toEqual([queued]);
  });

  it("a completed success with no start does not hide a later started failure", () => {
    const unstartedSuccess = { ...successRun("validate", 1), startedAt: null };
    const failure = successRun("validate", 2, "2026-01-01T00:05:00Z", "failure");

    expect(latestPerName([unstartedSuccess, failure])).toEqual([failure]);
    expect(latestPerName([failure, unstartedSuccess])).toEqual([failure]);
  });

  it("a completed failure with no start is not hidden by an older started success", () => {
    const success = successRun("validate", 1, "2026-01-01T00:05:00Z");
    const unstartedFailure = { ...successRun("validate", 2, undefined, "failure"), startedAt: null };

    expect(latestPerName([success, unstartedFailure])).toEqual([unstartedFailure]);
    expect(latestPerName([unstartedFailure, success])).toEqual([unstartedFailure]);
  });

  it("a completed run with no start and the higher id is the newer run", () => {
    const unstartedSuccess = { ...successRun("validate", 2), startedAt: null };
    const failure = successRun("validate", 1, "2026-01-01T00:05:00Z", "failure");

    expect(latestPerName([failure, unstartedSuccess])).toEqual([unstartedSuccess]);
  });

  it("a completed run with no start makes the whole name order by id, whatever order the API lists them in", () => {
    const unstarted = { ...successRun("validate", 2), startedAt: null };
    const earlyHighId = successRun("validate", 3, "2026-01-01T00:00:00Z", "failure");
    const lateLowId = successRun("validate", 1, "2026-01-01T00:05:00Z");
    const orders = [[earlyHighId, lateLowId, unstarted], [lateLowId, unstarted, earlyHighId], [unstarted, earlyHighId, lateLowId]];

    expect(orders.map((runs) => latestPerName(runs)[0]?.id)).toEqual([3, 3, 3]);
  });

  it("two unstarted runs tie to the higher id", () => {
    const queued = (id: number) => ({ ...successRun("validate", id), status: "queued", conclusion: null, startedAt: null });

    expect(latestPerName([queued(2), queued(1)]).map((run) => run.id)).toEqual([2]);
  });

  it("an empty list stays empty", () => {
    expect(latestPerName([])).toEqual([]);
  });
});

describe("isPassing", () => {
  it("a run still in progress is not passing even if it reports success", () => {
    expect(isPassing({ ...successRun("validate", 1), status: "in_progress", completedAt: null })).toBe(false);
  });

  it("a cancelled run is not passing", () => {
    expect(isPassing(successRun("validate", 1, undefined, "cancelled"))).toBe(false);
  });
});

describe("isPassing and isSucceeded fail closed", () => {
  const completed = (conclusion: string | null) => ({ ...successRun("validate", 1), conclusion });
  const running = (status: string) => ({ ...successRun("validate", 1), status, completedAt: null });

  it.each(["queued", "in_progress", "waiting", "bogus"])("a run with status %s is neither passing nor succeeded", (status) => {
    expect([isPassing(running(status)), isSucceeded(running(status))]).toEqual([false, false]);
  });

  it.each([null, "cancelled", "stale", "timed_out", "action_required", "startup_failure", "failure", "bogus"])("a completed run concluding %s is neither passing nor succeeded", (conclusion) => {
    expect([isPassing(completed(conclusion)), isSucceeded(completed(conclusion))]).toEqual([false, false]);
  });

  it.each(["neutral", "skipped"])("a completed run concluding %s is passing but not succeeded", (conclusion) => {
    expect([isPassing(completed(conclusion)), isSucceeded(completed(conclusion))]).toEqual([true, false]);
  });

  it("only a completed success is succeeded", () => {
    expect([isPassing(completed("success")), isSucceeded(completed("success"))]).toEqual([true, true]);
  });

  it("isPassingConclusion admits success, neutral and skipped only", () => {
    const conclusions = ["success", "neutral", "skipped", "failure", "cancelled", "stale", "bogus", null];

    expect(conclusions.filter(isPassingConclusion)).toEqual(["success", "neutral", "skipped"]);
  });
});

describe("isConcluded", () => {
  it("reads in_progress with a conclusion and a completion time as concluded", () => {
    expect(isConcluded({ ...successRun("validate", 1), status: "in_progress" })).toBe(true);
  });

  it("reads in_progress with a conclusion but no completion time as running", () => {
    expect(isConcluded({ ...successRun("validate", 1), status: "in_progress", completedAt: null })).toBe(false);
  });
});
