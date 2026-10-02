import type { WorkflowRun } from "@titan-design/workflow";
import { describe, expect, it } from "vitest";
import { busyRuns, drainForRestart, type BusyRun, type DrainOptions } from "./restart-drain.js";

const MINUTE = 60_000;
const REVIEW: BusyRun = { runId: "run-review", step: "sh-await-verdict:abc1234", phase: "review" };
const CHORE: BusyRun = { runId: "run-chore", step: "post-merge", phase: "park" };

function run(id: string, currentStep: string | null, status: WorkflowRun["status"] = "running"): WorkflowRun {
  return { id, workflowName: "land-pr", params: {}, status, currentStep, stepResults: {}, activeSteps: {}, revision: 1, ownerGeneration: 1, startedAt: "2026-01-01T00:00:00.000Z", completedAt: null, error: null };
}

const parkPostMerge = (stepId: string) => (stepId === "post-merge" ? { onRestart: "park" as const } : { onRestart: "repeat" as const });

/** Each /health answer takes the next busy list, and the last repeats; sleeping advances the fake clock. */
function fakeHealth(sequence: BusyRun[][]) {
  const answers = [...sequence];
  let clock = 0;
  let polls = 0;
  const ports = {
    health: async () => {
      polls += 1;
      return { ok: true, busy: answers.length > 1 ? answers.shift() : answers[0] };
    },
    sleep: async (ms: number) => void (clock += ms),
    now: () => clock,
  };
  return { ports, elapsed: () => clock, polls: () => polls };
}

async function drain(sequence: BusyRun[][], options: Partial<DrainOptions> = {}) {
  const machine = fakeHealth(sequence);
  const reports: string[] = [];
  const outcome = await drainForRestart(machine.ports, (text) => void reports.push(text), { port: 7410, timeoutMs: 45 * MINUTE, force: false, wait: true, ...options });
  return { outcome, reports, elapsed: machine.elapsed(), polls: machine.polls() };
}

describe("busy runs on /health", () => {
  it("lists running runs awaiting a verdict or merging, and skips other phases", () => {
    const runs = [run("a", "sh-await-verdict:abc1234"), run("b", "merge:0"), run("c", "ci-wait:0"), run("d", "sh-train-leave")];

    expect(busyRuns(runs, parkPostMerge)).toEqual([
      { runId: "a", step: "sh-await-verdict:abc1234", phase: "review" },
      { runId: "b", step: "merge:0", phase: "merging" },
      { runId: "d", step: "sh-train-leave", phase: "merging" },
    ]);
  });

  it("marks a step whose route parks on restart as park", () => {
    expect(busyRuns([run("a", "post-merge")], parkPostMerge)).toEqual([{ runId: "a", step: "post-merge", phase: "park" }]);
  });

  it("ignores runs that are not running or have no current step", () => {
    const runs = [run("a", "sh-await-verdict:abc1234", "paused"), run("b", null)];

    expect(busyRuns(runs, parkPostMerge)).toEqual([]);
  });
});

describe("draining before a restart", () => {
  it("proceeds at once when the service is idle", async () => {
    const { outcome, reports, elapsed } = await drain([[]]);

    expect(outcome).toEqual({ proceed: true });
    expect(reports).toEqual([]);
    expect(elapsed).toBe(0);
  });

  it("proceeds when nothing answers /health", async () => {
    const outcome = await drainForRestart({ health: async () => null, sleep: async () => undefined, now: () => 0 }, () => undefined, { port: 7410, timeoutMs: MINUTE, force: false, wait: true });

    expect(outcome).toEqual({ proceed: true });
  });

  it("waits while a review is busy, reporting it each minute, then proceeds once idle", async () => {
    const busyFor = Array.from({ length: 30 }, () => [REVIEW]);

    const { outcome, reports, elapsed } = await drain([...busyFor, []]);

    expect(outcome).toEqual({ proceed: true });
    expect(elapsed).toBe(150_000);
    expect(reports).toHaveLength(3);
    expect(reports[0]).toContain("run-review sh-await-verdict:abc1234 (review)");
  });

  it("restarts anyway when the timeout passes with only repeat-safe steps busy", async () => {
    const { outcome, reports, elapsed } = await drain([[REVIEW]], { timeoutMs: 10 * MINUTE });

    expect(outcome).toEqual({ proceed: true });
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

    expect(outcome).toEqual({ proceed: true });
  });

  it("checks once without waiting when the drain is skipped", async () => {
    const { outcome, elapsed, polls } = await drain([[REVIEW], []], { wait: false });

    expect(outcome).toEqual({ proceed: true });
    expect(elapsed).toBe(0);
    expect(polls).toBe(1);
  });

  it("still refuses a busy park-routed step when the drain is skipped", async () => {
    const { outcome } = await drain([[CHORE]], { wait: false });

    expect(outcome.proceed === false && outcome.why).toContain("--no-drain skipped the wait");
  });
});
