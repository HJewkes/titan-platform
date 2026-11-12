import { fakeGitHub, fakeSha, githubPort, successRun, type CheckRun, type PullRequest } from "@titan-design/github";
import type { RoutedStepInput } from "@titan-design/workflow";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { landRoutes } from "./land.js";
import { REPO } from "../test-support/land.js";

const POLL_MS = 30_000;
const TIMEOUT_MS = 45 * 60_000;
const T0 = 1_800_000_000_000;
const HEAD = fakeSha("release-head");
/** The base requires the fix-proof mutants job beside the CI jobs, as the release PR's base did. */
const REQUIRED = ["dag-check", "hub-compose", "validate", "fix-proof-mutants"];
const CI_RUN = 7001;
const PROOF_RUN = 7002;
const CANCELLED_RUN = 7003;
const FIX_PROOF_JOBS = ["fix-proof-base", "fix-proof", "fix-proof-head", "fix-proof-mutants"];
const RELEASE_HEAD = { headRef: "changeset-release/main", headRepo: REPO };

const Outcome = z.object({ ok: z.boolean(), error: z.string().optional(), output: z.string().optional() });
const Output = z.object({ result: z.object({ verdict: z.string() }) });

const job = (name: string, id: number, workflowRunId: number, conclusion: string | null): CheckRun => ({
  ...successRun(name, id, "2026-11-12T13:19:26Z", conclusion ?? "success"),
  workflowRunId,
  headSha: HEAD,
  ...(conclusion === null && { status: "in_progress", conclusion: null, completedAt: null }),
});

/** The release PR's CI workflow run: every job passed. */
const ciRun = (): CheckRun[] =>
  ["validate", "test-shard (3)", "test-shard (2)", "hub-compose", "test-shard (1)", "perf", "dag-check"].map((name, i) => job(name, 11 + i, CI_RUN, "success"));

/** The release PR's fix-proof workflow run: its `if:` skips every job on the release branch. */
const skippedProofRun = (): CheckRun[] => FIX_PROOF_JOBS.map((name, i) => job(name, 31 + i, PROOF_RUN, "skipped"));

async function ciWait(runs: CheckRun[], head: Partial<PullRequest> = RELEASE_HEAD) {
  const fake = fakeGitHub();
  fake.rules = { contexts: REQUIRED, strict: false };
  fake.addPr({ headSha: HEAD, mergeableState: "clean", ...head });
  fake.setRuns(HEAD, runs);
  const clock = { now: T0 };
  const route = landRoutes({ port: githubPort(fake.wire), now: () => clock.now, sleep: async (ms) => void (clock.now += ms), pollMs: POLL_MS, ciTimeoutMs: TIMEOUT_MS }).find((candidate) => candidate.match === "ci-wait");
  if (!route) throw new Error("no ci-wait route");
  const step: RoutedStepInput = { runId: "r", workflowName: "w", stepId: "ci-wait", iteration: 0, prompt: JSON.stringify({ repo: REPO, pr: 1, contexts: REQUIRED, strict: false }), signal: new AbortController().signal, attempt: 0, requestKey: "k" };
  const outcome = Outcome.parse(await route.runner.run(step));
  const verdict = outcome.output === undefined ? undefined : Output.parse(JSON.parse(outcome.output)).result.verdict;
  return { ...outcome, verdict, elapsed: clock.now - T0 };
}

describe("ci-wait settles a required fix-proof job that the workflow skipped at the head (TP-5470)", () => {
  it("reads the release PR's check set green: CI passed and the one fix-proof run skipped all four jobs", async () => {
    const out = await ciWait([...ciRun(), ...skippedProofRun()]);

    expect(out.verdict).toBe("green");
    expect(out.elapsed).toBeLessThanOrEqual(POLL_MS);
  });

  it("still waits on a skipped mutants job when the fix-proof workflow ran its other jobs at the head", async () => {
    const applied = FIX_PROOF_JOBS.map((name, i) => job(name, 31 + i, PROOF_RUN, name === "fix-proof-mutants" ? "skipped" : "success"));

    const out = await ciWait([...ciRun(), ...applied]);

    expect(out.ok).toBe(false);
    expect(out.error).toContain("waiting on fix-proof-mutants");
  });

  it("still waits while a fix-proof job at the head is running beside the skipped run", async () => {
    const running = job("fix-proof-base", 51, PROOF_RUN + 1, null);

    const out = await ciWait([...ciRun(), ...skippedProofRun(), running]);

    expect(out.ok).toBe(false);
    expect(out.error).toContain("waiting on fix-proof-mutants, fix-proof-base");
  });

  it("still waits on an all-skipped fix-proof run at a head that is not the release branch", async () => {
    const out = await ciWait([...ciRun(), ...skippedProofRun()], { headRef: "topic-1", headRepo: REPO });

    expect(out.ok).toBe(false);
    expect(out.error).toContain("waiting on fix-proof-mutants");
  });

  it("still waits on a release branch pushed from a fork, which the workflow does not exempt", async () => {
    const out = await ciWait([...ciRun(), ...skippedProofRun()], { ...RELEASE_HEAD, headRepo: "fork/demo" });

    expect(out.ok).toBe(false);
    expect(out.error).toContain("waiting on fix-proof-mutants");
  });

  it("still waits when a proof run's mutants job was cancelled and a later edit run skipped every job", async () => {
    const cancelled = FIX_PROOF_JOBS.map((name, i) => job(name, 21 + i, CANCELLED_RUN, name === "fix-proof-mutants" ? "cancelled" : name === "fix-proof" ? "skipped" : "success"));

    const out = await ciWait([...ciRun(), ...cancelled, ...skippedProofRun()], { headRef: "topic-1", headRepo: REPO });

    expect(out.ok).toBe(false);
    expect(out.error).toContain("waiting on fix-proof-mutants");
  });

  it("does not settle the release head when a proof job there ran and was cancelled before an all-skipped run", async () => {
    const cancelled = FIX_PROOF_JOBS.map((name, i) => job(name, 21 + i, CANCELLED_RUN, name === "fix-proof-mutants" ? "cancelled" : name === "fix-proof" ? "skipped" : "success"));

    const out = await ciWait([...ciRun(), ...cancelled, ...skippedProofRun()]);

    expect(out.verdict).not.toBe("green");
  });

  it("still waits when the skipped run is missing the judge, so not every fix-proof job is accounted for", async () => {
    const out = await ciWait([...ciRun(), ...skippedProofRun().filter((run) => run.name !== "fix-proof")]);

    expect(out.ok).toBe(false);
    expect(out.error).toContain("waiting on fix-proof-mutants");
  });
});
