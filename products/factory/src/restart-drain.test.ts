import type { WorkflowRun } from "@titan-design/workflow";
import { describe, expect, it } from "vitest";
import { behindTrain, busyRuns, describeBusy, drainForRestart, heldSkipped, NO_ANSWER_PROCEED_MS, type BusyRun, type DrainOptions } from "./restart-drain.js";

const MINUTE = 60_000;
const REVIEW: BusyRun = { runId: "run-review", step: "sh-await-verdict:abc1234", phase: "review" };
const CHORE: BusyRun = { runId: "run-chore", step: "post-merge", phase: "park" };

function run(id: string, currentStep: string | null, status: WorkflowRun["status"] = "running", workflowName = "land-pr"): WorkflowRun {
  return { id, workflowName, params: {}, status, currentStep, stepResults: {}, activeSteps: {}, revision: 1, ownerGeneration: 1, startedAt: "2026-01-01T00:00:00.000Z", completedAt: null, error: null };
}

const shepherdRun = (id: string, currentStep: string): WorkflowRun => run(id, currentStep, "running", "shepherd-pr");

const parkPostMerge = (stepId: string) => (stepId === "post-merge" ? { onRestart: "park" as const } : { onRestart: "repeat" as const });

/** Each /health answer takes the next busy list, or no answer for null, and the last repeats; sleeping advances the fake clock. */
function fakeHealth(sequence: (BusyRun[] | null)[]) {
  const answers = [...sequence];
  let clock = 0;
  let polls = 0;
  const ports = {
    health: async () => {
      polls += 1;
      const busy = answers.length > 1 ? answers.shift() : answers[0];
      return busy === null ? null : { ok: true, busy };
    },
    sleep: async (ms: number) => void (clock += ms),
    now: () => clock,
  };
  return { ports, elapsed: () => clock, polls: () => polls };
}

const silence = (polls: number): null[] => Array.from({ length: polls }, () => null);

async function drain(sequence: (BusyRun[] | null)[], options: Partial<DrainOptions> = {}) {
  const machine = fakeHealth(sequence);
  const reports: string[] = [];
  const outcome = await drainForRestart(machine.ports, (text) => void reports.push(text), { port: 7410, timeoutMs: 45 * MINUTE, force: false, wait: true, ...options });
  return { outcome, reports, elapsed: machine.elapsed(), polls: machine.polls() };
}

describe("busy runs on /health", () => {
  it("lists running runs dispatching a review or merging, and skips other phases", () => {
    const runs = [run("a", "sh-review:abc1234"), run("b", "merge:0"), run("c", "ci-wait:0"), run("d", "sh-train-leave")];

    expect(busyRuns(runs, parkPostMerge)).toEqual([
      { runId: "a", step: "sh-review:abc1234", phase: "review" },
      { runId: "b", step: "merge:0", phase: "merging" },
      { runId: "d", step: "sh-train-leave", phase: "merging" },
    ]);
  });

  it("does not wait on runs reading a seat's verdict, since the seat outlives the restart", () => {
    const runs = [run("a", "sh-await-verdict:abc1234"), run("b", "sh-await-verdict:abc1234:corrected"), run("c", "sh-late-verdict:abc1234"), run("d", "sh-seat-recheck:abc1234")];

    expect(busyRuns(runs, parkPostMerge)).toEqual([]);
  });

  it("does not wait on runs at a human gate step", () => {
    expect(busyRuns([run("a", "approve-merge:0"), run("b", "sh-held-wait:abc1234"), run("c", "merge-policy:0")], parkPostMerge)).toEqual([]);
  });

  it("does not wait on a run held at sh-no-reviewer-wait, though its watch phase is review", () => {
    expect(busyRuns([run("a", "sh-no-reviewer-wait:abc1234"), run("b", "sh-no-reviewer-hold:abc1234")], parkPostMerge)).toEqual([{ runId: "b", step: "sh-no-reviewer-hold:abc1234", phase: "review" }]);
  });

  it("does not wait on a run held at sh-account-wait, though its watch phase is review", () => {
    expect(busyRuns([run("a", "sh-account-wait:abc1234"), run("b", "sh-account-hold:abc1234")], parkPostMerge)).toEqual([{ runId: "b", step: "sh-account-hold:abc1234", phase: "review" }]);
  });

  it("marks a step whose route parks on restart as park", () => {
    expect(busyRuns([run("a", "post-merge")], parkPostMerge)).toEqual([{ runId: "a", step: "post-merge", phase: "park" }]);
  });

  it("ignores runs that are not running or have no current step", () => {
    const runs = [run("a", "sh-await-verdict:abc1234", "paused"), run("b", null)];

    expect(busyRuns(runs, parkPostMerge)).toEqual([]);
  });
});

describe("runs waiting on a merge train in the drain", () => {
  const parked = ["p1", "p2", "p3", "p4", "p5", "p6"].map((id) => shepherdRun(id, "merge:0"));
  const head = shepherdRun("head", "sh-await-verdict:abc1234");
  const heldBy = (holder: string | undefined) => behindTrain(() => holder);

  it("drains at once with 6 runs parked behind a train head that left for re-review", () => {
    const runs = [head, ...parked];

    expect(busyRuns(runs, parkPostMerge, heldBy("head"))).toEqual([]);
    expect(heldSkipped(runs, parkPostMerge, heldBy("head")).map((busy) => busy.runId)).toEqual(["p1", "p2", "p3", "p4", "p5", "p6"]);
  });

  it("waits on the run that holds the train, since it may be merging", () => {
    expect(busyRuns([shepherdRun("head", "merge:0")], parkPostMerge, heldBy("head"))).toEqual([{ runId: "head", step: "merge:0", phase: "merging" }]);
  });

  it("waits on a run at merge when no run holds the train, since it boards and merges at once", () => {
    expect(busyRuns(parked.slice(0, 1), parkPostMerge, heldBy(undefined))).toHaveLength(1);
  });

  it("waits on a land-pr run at merge, which never rides the train", () => {
    expect(busyRuns([run("land", "merge:0")], parkPostMerge, heldBy("head"))).toHaveLength(1);
  });

  it("waits on a run past the merge step, though another run holds the train", () => {
    expect(busyRuns([shepherdRun("settling", "merge-settle:0"), shepherdRun("leaving", "sh-train-leave:0")], parkPostMerge, heldBy("head"))).toHaveLength(2);
  });
});

describe("held runs in the drain", () => {
  const held = (...ids: string[]) => (candidate: WorkflowRun) => ids.includes(candidate.id);
  const runs = [run("held", "merge:0"), run("free", "merge:0")];

  it("skips a held run in merge:0 and still counts an unheld one", () => {
    expect(busyRuns(runs, parkPostMerge, held("held"))).toEqual([{ runId: "free", step: "merge:0", phase: "merging" }]);
  });

  it("names the held run it skipped", () => {
    const skipped = heldSkipped(runs, parkPostMerge, held("held"));

    expect(skipped).toEqual([{ runId: "held", step: "merge:0", phase: "merging" }]);
    expect(describeBusy([], skipped)).toContain("held merge:0 (held, not waited for)");
  });

  it("keeps a held run in a review step busy", () => {
    expect(busyRuns([run("held", "sh-review:abc1234")], parkPostMerge, held("held"))).toHaveLength(1);
  });

  it("keeps a held run in a park-routed step busy", () => {
    expect(busyRuns([run("held", "post-merge")], parkPostMerge, held("held"))).toEqual([{ runId: "held", step: "post-merge", phase: "park" }]);
  });

  it("counts a run busy when its hold cannot be read", () => {
    const unreadable = () => {
      throw new Error("the shepherd store is not bound");
    };

    expect(busyRuns(runs, parkPostMerge, unreadable)).toHaveLength(2);
    expect(heldSkipped(runs, parkPostMerge, unreadable)).toEqual([]);
  });

  it("proceeds when only held runs remain and reports them", async () => {
    const machine = fakeHealth([[]]);
    const reports: string[] = [];
    const health = async () => ({ ok: true, busy: [], heldSkipped: [{ runId: "held", step: "merge:0", phase: "merging" }] });

    const outcome = await drainForRestart({ ...machine.ports, health }, (text) => void reports.push(text), { port: 7410, timeoutMs: 45 * MINUTE, force: false, wait: true });

    expect(outcome).toMatchObject({ proceed: true });
    expect(reports[0]).toContain("held merge:0");
  });
});

describe("draining before a restart", () => {
  it("proceeds at once when the service is idle", async () => {
    const { outcome, reports, elapsed } = await drain([[]]);

    expect(outcome).toMatchObject({ proceed: true });
    expect(reports).toEqual([]);
    expect(elapsed).toBe(0);
  });

  it("hands the restart the last answer it read, with the runs still busy at the deadline", async () => {
    const { outcome } = await drain([[REVIEW]], { timeoutMs: MINUTE });

    expect(outcome).toEqual({ proceed: true, atRestart: { ok: true, busy: [REVIEW] } });
  });

  it("hands the restart no answer when serve stayed silent", async () => {
    expect((await drain([null])).outcome).toEqual({ proceed: true, atRestart: null });
  });

  it("a /health that stops answering while runs are busy does not end the drain", async () => {
    const { outcome, elapsed, polls } = await drain([[REVIEW], ...silence(10), [REVIEW], []]);

    expect(outcome).toMatchObject({ proceed: true });
    expect(polls).toBe(13);
    expect(elapsed).toBe(60_000);
  });

  it("a serve that never answers is restarted after two minutes of silence", async () => {
    const { outcome, reports, elapsed } = await drain([null]);

    expect(outcome).toMatchObject({ proceed: true });
    expect(elapsed).toBe(NO_ANSWER_PROCEED_MS);
    expect(reports[0]).toContain("serve did not answer /health; still draining");
    expect(reports.at(-1)).toContain("serve has not answered /health for 2 min; restarting it");
  });

  it("an answer resets the silence streak", async () => {
    const { outcome, reports, polls } = await drain([...silence(20), [REVIEW], ...silence(20), []]);

    expect(outcome).toMatchObject({ proceed: true });
    expect(polls).toBe(42);
    expect(reports.join("")).not.toContain("restarting it");
  });

  it("restarts a silent serve at a deadline shorter than the silence limit", async () => {
    const { outcome, elapsed } = await drain([null], { timeoutMs: MINUTE });

    expect(outcome).toMatchObject({ proceed: true });
    expect(elapsed).toBe(MINUTE);
  });

  it("wait:false still proceeds on no answer", async () => {
    const { outcome, elapsed, polls } = await drain([null, [REVIEW]], { wait: false });

    expect(outcome).toMatchObject({ proceed: true });
    expect(elapsed).toBe(0);
    expect(polls).toBe(1);
  });

  it("waits while a review is busy, reporting it each minute, then proceeds once idle", async () => {
    const busyFor = Array.from({ length: 30 }, () => [REVIEW]);

    const { outcome, reports, elapsed } = await drain([...busyFor, []]);

    expect(outcome).toMatchObject({ proceed: true });
    expect(elapsed).toBe(150_000);
    expect(reports).toHaveLength(3);
    expect(reports[0]).toContain("run-review sh-await-verdict:abc1234 (review)");
  });

  it("restarts anyway when the timeout passes with only repeat-safe steps busy", async () => {
    const { outcome, reports, elapsed } = await drain([[REVIEW]], { timeoutMs: 10 * MINUTE });

    expect(outcome).toMatchObject({ proceed: true });
    expect(elapsed).toBe(10 * MINUTE);
    expect(reports.at(-1)).toContain("the drain timed out; restarting with 1 busy run(s)");
  });

  it("refuses when a park-routed step is still busy at the timeout", async () => {
    const { outcome } = await drain([[REVIEW, CHORE]], { timeoutMs: 10 * MINUTE });

    expect(outcome.proceed).toBe(false);
    expect(outcome.proceed === false && outcome.why).toContain("run-chore post-merge (park)");
    expect(outcome.proceed === false && outcome.why).not.toContain("run-review");
  });

  it("restarts over a busy park-routed step with force", async () => {
    const { outcome } = await drain([[CHORE]], { timeoutMs: 10 * MINUTE, force: true });

    expect(outcome).toMatchObject({ proceed: true });
  });

  it("checks once without waiting when the drain is skipped", async () => {
    const { outcome, elapsed, polls } = await drain([[REVIEW], []], { wait: false });

    expect(outcome).toMatchObject({ proceed: true });
    expect(elapsed).toBe(0);
    expect(polls).toBe(1);
  });

  it("still refuses a busy park-routed step when the drain is skipped", async () => {
    const { outcome } = await drain([[CHORE]], { wait: false });

    expect(outcome.proceed === false && outcome.why).toContain("--no-drain skipped the wait");
  });
});
