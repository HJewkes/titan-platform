import { formatResultLine, type FixProofResult } from "@titan-design/fix-proof";
import { fakeGitHub, fakeSha, githubPort, successRun, type CheckRun, type FakeGitHub } from "@titan-design/github";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { H1, REPO } from "../test-support/land.js";
import { factoryRoutesFor } from "../workflows.js";
import { sleep } from "../workflows/land.js";
import { FIX_PROOF_CHECK } from "./fix-proof.js";
import { FIX_PROOF_WAKE_STEP, fixProofBounce } from "./fix-proof-cap.js";
import type { ShepherdPhases } from "./phases.js";
import { shepherdPrWorkflow } from "./pr.js";
import { OWNER_GATE_POLICY } from "./policy.js";
import type { EffectivePolicy } from "./policy-schema.js";
import { reviewPhase } from "./review.js";
import { shepherdStoreRef, type ShepherdStoreRef } from "./store.js";

const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

const MERGE_BASE = fakeSha("reruns-merge-base");
const POLICY: EffectivePolicy = { ...OWNER_GATE_POLICY, fixer: true, seat: "demo-seat" };
const REVIEW_INTENT = /^sh-review-intent/;

/** The judge's line for a new test that passes on the base as well as the head: the fix is not reproduced. */
function vacuousLine(proofRun: number): string {
  const counts: FixProofResult["counts"] = { reproduces: 0, "passes-on-base": 1, "new-api": 0, "fails-on-head": 0, "not-run": 0 };
  const tests = [{ file: "src/a.test.ts", name: `passes with or without the fix ${proofRun}`, class: "passes-on-base" as const }];
  return formatResultLine({ head: H1, mergeBase: MERGE_BASE, base: "main", verdict: "vacuous", counts, notCollected: [], deletedTests: [], configEdited: false, tests, truncated: false });
}

const proofRun = (id: number): CheckRun => ({ ...successRun(FIX_PROOF_CHECK, id), headSha: H1, pullRequests: [{ number: 1, baseRef: "main" }] });

/** A green correctness fix PR whose fix-proof workflow ran once per reopen, each run judging main and reading vacuous. */
function reopenedPr(proofRuns: readonly number[]): FakeGitHub {
  const fake = fakeGitHub();
  fake.addPr({ headSha: H1, headRef: "fix/demo", mergeSha: fakeSha("test-merge") });
  fake.prFiles.set(1, [{ path: "src/a.ts", status: "modified" }, { path: "src/a.test.ts", status: "added" }]);
  fake.onGetPr = (pr) => fake.setRuns(pr.headSha, [successRun("validate", 1), successRun("dag-check", 2), ...proofRuns.map(proofRun)]);
  for (const id of proofRuns) fake.jobLogs.set(id, `2026-01-01T12:00:00.0000000Z ${vacuousLine(id)}`);
  return fake;
}

/** The real review phase reads the proof; the wake only counts its fix-proof bounce and leaves the rest to the owner. */
const PHASES: ShepherdPhases = {
  review: reviewPhase,
  wake: async (ctx, request) => (await fixProofBounce(ctx, request)) ?? { kind: "unhandled", reason: "no agent in this test" },
};

function start(fake: FakeGitHub): { host: FactoryHost; runId: string } {
  let clock = 0;
  const store: ShepherdStoreRef = shepherdStoreRef();
  const routes = factoryRoutesFor({ port: githubPort(fake.wire), store, now: () => clock, sleep: async (ms, signal) => ((clock += ms), sleep(1, signal)) });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [shepherdPrWorkflow(PHASES)], routes, gatePollMs: 5 });
  hosts.push(host);
  const runId = host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", policy: JSON.stringify(POLICY) });
  store.get().register({ repo: REPO, pr: 1, runId, task: "demo/1", implementer: "impl-a", policy: POLICY, kind: "correctness" });
  return { host, runId };
}

const stepIds = (host: FactoryHost, runId: string): string[] => Object.values(host.runtime.status(runId)!.stepResults).map((result) => result.stepId);

describe("a correctness fix PR whose fix-proof ran once per reopen and read vacuous each time (TP-4788)", () => {
  it.each([
    ["one run", [77]],
    ["three runs at the same head", [77, 78, 79]],
  ])("wakes the fixer for a reproducing test and never reaches review intent (%s)", async (_case, proofRuns) => {
    const { host, runId } = start(reopenedPr(proofRuns));

    await vi.waitFor(() => expect(stepIds(host, runId).some((id) => id === FIX_PROOF_WAKE_STEP || REVIEW_INTENT.test(id))).toBe(true), { timeout: 10_000 });

    expect(stepIds(host, runId)).toContain(FIX_PROOF_WAKE_STEP);
    expect(stepIds(host, runId).filter((id) => REVIEW_INTENT.test(id))).toEqual([]);
  });
});
