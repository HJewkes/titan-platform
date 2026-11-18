import { fakeGitHub, fakeSha, githubPort, successRun, type CheckRun } from "@titan-design/github";
import type { RoutedStepInput } from "@titan-design/workflow";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { landRoutes } from "./land.js";
import { REPO } from "../test-support/land.js";

const POLL_MS = 30_000;
const TIMEOUT_MS = 45 * 60_000;
const T0 = 1_800_000_000_000;
const HEAD = fakeSha("skipped-head");
const REQUIRED = ["dag-check", "hub-compose", "validate"];
/** tp#3329's two fix-proof workflow runs at one head: the push's run, then the PR-edit run that skipped every job. */
const PUSH_RUN = 42478488621;
const EDIT_RUN = 42478515177;
const RERUN = 5001;

const Outcome = z.object({ ok: z.boolean(), error: z.string().optional(), output: z.string().optional() });
const Failing = z.array(z.object({ name: z.string(), workflowRunId: z.number().nullable() }));
const Output = z.object({ result: z.object({ verdict: z.string(), failing: Failing.optional() }) });

const job = (name: string, id: number, workflowRunId: number, timing: { startedAt: string; completedAt: string | null }, conclusion: string | null): CheckRun => ({
  ...successRun(name, id, timing.startedAt, conclusion ?? "success"),
  workflowRunId,
  completedAt: timing.completedAt,
  ...(conclusion === null && { status: "in_progress", conclusion: null, completedAt: null }),
});

const at = (startedAt: string, completedAt: string | null = startedAt) => ({ startedAt: `2026-11-08T${startedAt}Z`, completedAt: completedAt && `2026-11-08T${completedAt}Z` });

const requiredGreen = (): CheckRun[] => REQUIRED.map((name, i) => job(name, 11 + i, 2001, at("12:03:50", "12:10:00"), "success"));

/** Run 42478488621 as GitHub listed it: the mutants job failed and the gate job passed after the edit run. */
const pushRun = (mutants: string | null): CheckRun[] => [
  job("fix-proof-base", 31, PUSH_RUN, at("12:03:57", "12:08:16"), "success"),
  job("fix-proof-mutants", 32, PUSH_RUN, at("12:03:58", "12:05:00"), mutants),
  job("fix-proof-head", 33, PUSH_RUN, at("12:03:58", "12:08:20"), "success"),
  job("fix-proof", 34, PUSH_RUN, at("12:08:22", "12:08:58"), "success"),
];

/** Run 42478515177 as GitHub listed it: every job skipped, two of them started after their completion time. */
const editRun = (): CheckRun[] => [
  job("fix-proof-base", 41, EDIT_RUN, at("12:04:17"), "skipped"),
  job("fix-proof", 42, EDIT_RUN, at("12:04:17"), "skipped"),
  job("fix-proof-head", 43, EDIT_RUN, at("12:04:23", "12:04:17"), "skipped"),
  job("fix-proof-mutants", 44, EDIT_RUN, at("12:04:24", "12:04:17"), "skipped"),
];

async function ciWait(runs: CheckRun[]) {
  const fake = fakeGitHub();
  fake.rules = { contexts: REQUIRED, strict: false };
  fake.addPr({ headSha: HEAD, mergeableState: "clean" });
  fake.setRuns(HEAD, runs.map((run) => ({ ...run, headSha: HEAD })));
  const clock = { now: T0 };
  const route = landRoutes({ port: githubPort(fake.wire), now: () => clock.now, sleep: async (ms) => void (clock.now += ms), pollMs: POLL_MS, ciTimeoutMs: TIMEOUT_MS }).find((candidate) => candidate.match === "ci-wait");
  if (!route) throw new Error("no ci-wait route");
  const step: RoutedStepInput = { runId: "r", workflowName: "w", stepId: "ci-wait", iteration: 0, prompt: JSON.stringify({ repo: REPO, pr: 1, contexts: REQUIRED, strict: false }), signal: new AbortController().signal, attempt: 0, requestKey: "k" };
  const outcome = Outcome.parse(await route.runner.run(step));
  const result = outcome.output === undefined ? undefined : Output.parse(JSON.parse(outcome.output)).result;
  return { ...outcome, verdict: result?.verdict, failing: result?.failing, elapsed: clock.now - T0 };
}

describe("ci-wait reads a failure that a newer skip hides as red, not green and not pending", () => {
  it("tp#3329: run 42478488621's failed mutants job, then run 42478515177's skip, reads red naming the failure", async () => {
    const out = await ciWait([...requiredGreen(), ...pushRun("failure"), ...editRun()]);

    expect(out.verdict).toBe("red");
    expect(out.failing).toEqual([{ name: "fix-proof-mutants", workflowRunId: PUSH_RUN }]);
    expect(out.elapsed).toBeLessThan(TIMEOUT_MS);
  });

  it("reads green when the skips follow a push run that passed, since no earlier failure is hidden", async () => {
    const out = await ciWait([...requiredGreen(), ...pushRun("success"), ...editRun()]);

    expect(out.verdict).toBe("green");
    expect(out.elapsed).toBeLessThanOrEqual(POLL_MS);
  });

  it("keeps waiting while the push run's mutants job is still running beside the newer skip", async () => {
    const out = await ciWait([...requiredGreen(), ...pushRun(null), ...editRun()]);

    expect(out.ok).toBe(false);
    expect(out.error).toContain("waiting on fix-proof-mutants");
  });

  it("keeps waiting on a rerun still going between the failure and the newer skip", async () => {
    const rerun = job("fix-proof-mutants", 52, RERUN, at("12:04:10", null), null);

    const out = await ciWait([...requiredGreen(), ...pushRun("failure"), rerun, ...editRun()]);

    expect(out.ok).toBe(false);
    expect(out.error).toContain("waiting on fix-proof-mutants");
  });

  it("reads red, not green, when the push run's base job and gate failed and the edit run skipped them", async () => {
    const failedGate = pushRun("success").map((run) => (run.name === "fix-proof-base" || run.name === "fix-proof" ? { ...run, conclusion: "failure" } : run));

    const out = await ciWait([...requiredGreen(), ...failedGate, ...editRun()]);

    expect(out.verdict).toBe("red");
    expect(out.failing?.map((check) => check.name).sort()).toEqual(["fix-proof", "fix-proof-base"]);
  });

  it("reads an older failure red beside a newer passing rerun, though a skip is newer than both (TP-497)", async () => {
    const rerun = job("fix-proof-mutants", 52, RERUN, at("12:04:10", "12:04:20"), "success");

    const out = await ciWait([...requiredGreen(), ...pushRun("failure"), rerun, ...editRun()]);

    expect(out.verdict).toBe("red");
    expect(out.failing).toEqual([{ name: "fix-proof-mutants", workflowRunId: PUSH_RUN }]);
  });

  it("still waits on a required context with no run, beside settled skips", async () => {
    const out = await ciWait([...requiredGreen().slice(0, 2), ...pushRun("success"), ...editRun()]);

    expect(out.verdict).not.toBe("green");
    expect(out.error).toContain("waiting on validate");
  });
});
