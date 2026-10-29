import { fakeGitHub, fakeSha, githubPort, successRun, type FakeGitHub } from "@titan-design/github";
import { partialFake } from "@titan-design/test-kit";
import type { WorkflowContext } from "@titan-design/workflow";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { H1, REPO, gateId, gateOpened } from "../test-support/land.js";
import { OWNER } from "../test-support/resolver.js";
import { factoryRoutesFor } from "../workflows.js";
import { sleep } from "../workflows/land.js";
import type { ShepherdPhases, Verdict, WakeRequest } from "./phases.js";
import { OWNER_GATE_POLICY, type EffectivePolicy } from "./policy.js";
import { shepherdPrWorkflow } from "./pr.js";
import { shepherdStoreRef } from "./store.js";
import type { WorkflowCiRead } from "./workflow-ci-proof.js";
import { noFixerAnswers } from "./send-back.js";

const H2 = fakeSha("workflow-ci-merge-up");
const BASE = fakeSha("workflow-ci-base");
const AUTO: EffectivePolicy = { ...OWNER_GATE_POLICY, merge: "auto", fixer: true, seat: "demo-seat" };
const G10_ADVERSARY = "g10-adversary: authority touch";
const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

const green = (head: string) => ["validate", "dag-check"].map((name, i) => ({ name, sha: head, runId: i + 1, conclusion: "success" }));

/** The fix-proof's read of a workflow-only head whose required checks passed at the merge base and at the head. */
function workflowCiRead(head: string): WorkflowCiRead {
  return { kind: "workflow-ci", proved: false, head, mergeBase: BASE, base: green(BASE), atHead: green(head), reason: "the PR changes only .github/workflows/" };
}

/** tp#2325: a held workflow-only PR whose every head is read behind with its own checks green, and no fixer pushes anything. */
function workflowOnlyRun(proof: (head: string) => Verdict) {
  const fake: FakeGitHub = fakeGitHub();
  fake.onGetPr = (pr) => fake.setRuns(pr.headSha, [successRun("validate", 1), successRun("dag-check", 2)]);
  const [wakes, reviewed]: [WakeRequest[], string[]] = [[], []];
  const phases: ShepherdPhases = {
    wake: async (_ctx, request) => (wakes.push(request), { kind: "unhandled", reason: "the fixer had nothing to push" }),
    review: async (_ctx, request) => (reviewed.push(request.headSha), proof(request.headSha)),
  };
  const ref = shepherdStoreRef();
  let clock = 0;
  const routes = factoryRoutesFor({ port: githubPort(fake.wire), store: ref, now: () => clock, sleep: async (ms, signal) => ((clock += ms), sleep(1, signal)), park: async () => ({ lines: [] }), heldRepair: "on" });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [shepherdPrWorkflow(phases)], routes, gatePollMs: 5 });
  hosts.push(host);
  fake.addPr({ headSha: H1, mergeSha: fakeSha("workflow-ci-merge"), mergeableState: "behind", behind: true });
  const runId = host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", policy: JSON.stringify(AUTO) });
  ref.get().register({ repo: REPO, pr: 1, runId, task: "demo/1", implementer: "impl-a", policy: AUTO });
  ref.get().hold(runId, G10_ADVERSARY);
  return { host, fake, runId, wakes, reviewed };
}

const optionIds = (host: FactoryHost, id: string) => host.gates.get(id)?.questions?.flatMap((question) => question.options.map((option) => option.id));
const noRepro = (head: string): Verdict => ({ kind: "NO_REPRO", headSha: head, result: workflowCiRead(head) });

describe("a workflow-only NO_REPRO on a held PR read behind with green checks (TP-4109, tp#2325)", () => {
  it("wakes no fixer at r0 or at r1 after main moved, and asks the owner a waivable send-back at each head", async () => {
    const w = workflowOnlyRun(noRepro);
    const first = gateId(w.runId, "sh-sent-back");
    await gateOpened(w.host, first);

    expect(w.wakes).toEqual([]);
    expect(w.host.gates.get(first)?.prompt).toContain(`at head ${H1}: the PR changes only workflows`);
    w.host.runtime.signal(w.runId, "sh-sent-back", { decision: "await-new-head" }, OWNER);
    w.fake.pushHead(1, H2);
    const second = gateId(w.runId, "sh-sent-back", 1);
    await gateOpened(w.host, second);

    expect(w.wakes).toEqual([]);
    expect(w.reviewed).toEqual([H1, H2]);
    expect(optionIds(w.host, second)).toEqual(["await-new-head", "abandon", "waive-proof"]);
    expect(w.host.gates.get(second)?.prompt).toContain(`at head ${H2}`);
  });

  it("still wakes the fix-proof fixer for a NO_REPRO that is no workflow-ci read", async () => {
    const w = workflowOnlyRun((head) => ({ kind: "NO_REPRO", headSha: head, result: { verdict: "vacuous" } }));

    await vi.waitFor(() => expect(w.wakes).toHaveLength(1), { timeout: 5_000 });

    expect(w.wakes[0]).toMatchObject({ kind: "fix-proof", headSha: H1 });
  });
});

describe("a workflow-ci NO_REPRO recorded before TP-4109", () => {
  const recordedNext = (next: string | undefined) => partialFake<WorkflowContext>({ historyNext: () => next });

  it("replays the fixer wake it recorded, and asks the gate live or where the record asked it", () => {
    expect(noFixerAnswers(recordedNext(`sh-held-check:r0:${H1}`), noRepro(H1))).toBe(false);
    expect(noFixerAnswers(recordedNext(undefined), noRepro(H1))).toBe(true);
    expect(noFixerAnswers(recordedNext("sh-sent-back"), noRepro(H1))).toBe(true);
  });
});
