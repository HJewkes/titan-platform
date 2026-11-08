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
const SYNC_START = "2026-01-01T12:03:58Z";
const EDIT_START = "2026-01-01T12:04:24Z";
const GATE_START = "2026-01-01T12:08:22Z";

const Outcome = z.object({ ok: z.boolean(), error: z.string().optional(), output: z.string().optional() });
const Output = z.object({ result: z.object({ verdict: z.string(), waitingOn: z.array(z.string()).optional() }) });

const job = (name: string, id: number, workflowRunId: number, startedAt: string, conclusion: string | null): CheckRun => ({
  ...successRun(name, id, startedAt, conclusion ?? "success"),
  workflowRunId,
  ...(conclusion === null && { status: "in_progress", conclusion: null, completedAt: null }),
});

const requiredGreen = (): CheckRun[] => REQUIRED.map((name, i) => job(name, 11 + i, 2001, SYNC_START, "success"));

/** A PR-body edit starts a second fix-proof run at the same head, and that run skips every job. */
const editRunSkips = (): CheckRun[] => ["fix-proof-base", "fix-proof-head", "fix-proof-mutants", "fix-proof"].map((name, i) => job(name, 41 + i, 4001, EDIT_START, "skipped"));

/** The push's fix-proof run: its mutants job failed before the edit, and its gate judged the reports after the edit. */
const pushRun = (mutants: string | null): CheckRun[] => [
  job("fix-proof-base", 31, 3001, SYNC_START, "success"),
  job("fix-proof-head", 32, 3001, SYNC_START, "success"),
  job("fix-proof-mutants", 33, 3001, SYNC_START, mutants),
  job("fix-proof", 34, 3001, GATE_START, "success"),
];

async function ciWait(runs: CheckRun[]) {
  const fake = fakeGitHub();
  fake.rules = { contexts: REQUIRED, strict: false };
  fake.addPr({ headSha: HEAD, mergeableState: "clean" });
  fake.setRuns(HEAD, runs);
  const clock = { now: T0 };
  const route = landRoutes({ port: githubPort(fake.wire), now: () => clock.now, sleep: async (ms) => void (clock.now += ms), pollMs: POLL_MS, ciTimeoutMs: TIMEOUT_MS }).find((candidate) => candidate.match === "ci-wait");
  if (!route) throw new Error("no ci-wait route");
  const step: RoutedStepInput = { runId: "r", workflowName: "w", stepId: "ci-wait", iteration: 0, prompt: JSON.stringify({ repo: REPO, pr: 1, contexts: REQUIRED, strict: false }), signal: new AbortController().signal, attempt: 0, requestKey: "k" };
  const outcome = Outcome.parse(await route.runner.run(step));
  const result = outcome.output === undefined ? undefined : Output.parse(JSON.parse(outcome.output)).result;
  return { ...outcome, verdict: result?.verdict, elapsed: clock.now - T0 };
}

describe("ci-wait settles on a check whose newest run at the head was skipped", () => {
  it("tp#3329: a skipped mutants job from a PR-edit run settles the push run's failed one, so ci-wait reads green within a poll", async () => {
    const out = await ciWait([...requiredGreen(), ...pushRun("failure"), ...editRunSkips()]);

    expect(out.verdict).toBe("green");
    expect(out.elapsed).toBeLessThanOrEqual(POLL_MS);
  });

  it("keeps waiting while the push run's mutants job is still running beside the newer skip", async () => {
    const out = await ciWait([...requiredGreen(), ...pushRun(null), ...editRunSkips()]);

    expect(out.ok).toBe(false);
    expect(out.error).toContain("waiting on fix-proof-mutants");
    expect(out.elapsed).toBeGreaterThanOrEqual(TIMEOUT_MS);
  });

  it("never passes a required context whose failure a newer skip shadows: a skip is not a success", async () => {
    const required = [job("dag-check", 11, 2001, SYNC_START, "success"), job("hub-compose", 12, 2001, SYNC_START, "success"), job("validate", 13, 2001, SYNC_START, "failure"), job("validate", 23, 2002, EDIT_START, "skipped")];

    const out = await ciWait([...required, ...pushRun("success")]);

    expect(out.verdict).not.toBe("green");
    expect(out.error).toContain("waiting on validate");
  });

  it("never passes when a required context has no run, though every other check settled on a skip", async () => {
    const out = await ciWait([...requiredGreen().slice(0, 2), ...pushRun("failure"), ...editRunSkips()]);

    expect(out.verdict).not.toBe("green");
    expect(out.error).toContain("waiting on validate");
  });
});
