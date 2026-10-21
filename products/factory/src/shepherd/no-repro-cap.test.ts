import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeGitHub, fakeSha, githubPort, successRun, type FakeGitHub } from "@titan-design/github";
import type { SourceTextLocator } from "@titan-design/session-read";
import { partialFake } from "@titan-design/test-kit";
import type { WorkflowContext } from "@titan-design/workflow";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkflowDefinition } from "../definition.js";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { H1, REPO } from "../test-support/land.js";
import { factoryRoutesFor } from "../workflows.js";
import { sleep } from "../workflows/land.js";
import { autoPassStepId } from "./auto-pass.js";
import { onFixFirstEscalated, type FixFirstDemotionRun } from "./fix-first-demotion.js";
import { fixProofBounce } from "./fix-proof-cap.js";
import type { ReviewRequest, ShepherdPhases, Verdict, WakeRequest } from "./phases.js";
import { shepherdPrWorkflow } from "./pr.js";
import { OWNER_GATE_POLICY, type EffectivePolicy } from "./policy.js";
import { mergeVerdict } from "./review.js";
import { recordFixFirst } from "./routed.js";
import { shepherdStoreRef, type ShepherdStoreRef } from "./store.js";
import { FIX_FIRST_STEP } from "./wake-brief.js";

const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

const AUTO_POLICY: EffectivePolicy = { ...OWNER_GATE_POLICY, merge: "auto", fixer: true, seat: "trusted-seat" };
const reviewer = { agentId: "agent-rv-1", sessionId: "session-rv-1" };
const locator = { sourceId: "synthetic-transcript" } as unknown as SourceTextLocator;
const D8_STEP = /^sh-auto-pass:D8-convergence-review/;

type Answer = "NO_REPRO" | "FIX_FIRST" | "MERGE";

/** Each head answers by the order the run first reviewed it; heads past the script say MERGE. */
function scripted(answers: readonly Answer[], late: { fake?: FakeGitHub }) {
  const seen: string[] = [];
  const wakes: WakeRequest["kind"][] = [];
  const answerAt = (headSha: string): Answer => {
    if (!seen.includes(headSha)) seen.push(headSha);
    return answers[seen.indexOf(headSha)] ?? "MERGE";
  };
  const review: ShepherdPhases["review"] = async (ctx, request: ReviewRequest): Promise<Verdict> => {
    const answer = answerAt(request.headSha);
    if (answer === "NO_REPRO") return { kind: "NO_REPRO", headSha: request.headSha, result: { verdict: "vacuous" } };
    if (answer === "FIX_FIRST") return { kind: "FIX_FIRST", headSha: request.headSha, text: "synthetic finding" };
    return mergeVerdict(ctx, { ...request, head: request.headSha, verdict: { value: "MERGE", head: request.headSha, locator }, resolver: reviewer, dispatchedReviewer: reviewer, seatGrants: ["merge-on-green-approve"] });
  };
  const wake: ShepherdPhases["wake"] = async (ctx, request) => {
    const capped = await fixProofBounce(ctx, request);
    if (capped !== undefined) return capped;
    wakes.push(request.kind);
    late.fake!.pushHead(1, fakeSha(`fix-${wakes.length}`));
    return { kind: "woken", agent: "impl-a" };
  };
  return { phases: { review, wake }, wakes };
}

function openHost(fake: FakeGitHub, store: ShepherdStoreRef, workflow: WorkflowDefinition, dbPath = ":memory:"): FactoryHost {
  let clock = 0;
  const port = githubPort(fake.wire);
  const mainGreen = { ...port, checkRuns: async (repo: string, sha: string) => (sha === fake.pr(1).mergeSha && fake.setRuns(sha, [successRun("validate", 9), successRun("dag-check", 10)]), port.checkRuns(repo, sha)) };
  const routes = factoryRoutesFor({ port: mainGreen, store, now: () => clock, sleep: async (ms, signal) => ((clock += ms), sleep(1, signal)) });
  const host = openFactoryHost({ dbPath, workflows: [workflow], routes, gatePollMs: 5 });
  hosts.push(host);
  return host;
}

function greenPr(): FakeGitHub {
  const fake = fakeGitHub();
  fake.onGetPr = (pr) => fake.setRuns(pr.headSha, [successRun("validate", 1), successRun("dag-check", 2)]);
  fake.addPr({ headSha: H1, mergeSha: fakeSha("test-merge") });
  fake.prFiles.set(1, [{ path: "src/a.ts", status: "modified" }]);
  return fake;
}

function startRun(host: FactoryHost, store: ShepherdStoreRef): string {
  const runId = host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", policy: JSON.stringify(AUTO_POLICY) });
  store.get().register({ repo: REPO, pr: 1, runId, task: "demo/1", implementer: "impl-a", policy: AUTO_POLICY });
  return runId;
}

function scene(answers: readonly Answer[]) {
  const late: { fake?: FakeGitHub } = {};
  const fake = (late.fake = greenPr());
  const { phases, wakes } = scripted(answers, late);
  const store = shepherdStoreRef();
  const host = openHost(fake, store, shepherdPrWorkflow(phases));
  return { fake, host, wakes, runId: startRun(host, store) };
}

const stepIds = (host: FactoryHost, runId: string): string[] => Object.values(host.runtime.status(runId)!.stepResults).map((result) => result.stepId);
const pendingOf = (host: FactoryHost, runId: string) => host.pendingGates().filter((gate) => gate.runId === runId);

/** The run merged, opened a gate, or went to wait for a head nobody will push. */
function settled(host: FactoryHost, runId: string, fake: FakeGitHub): boolean {
  return fake.pr(1).merged || pendingOf(host, runId).length > 0 || /await-new-head/.test(host.runtime.status(runId)?.currentStep ?? "");
}

describe("a fix-proof NO_REPRO send-back (TP-3900)", () => {
  it("leaves three NO_REPRO rounds to the fix-proof cap's owner gate, never fix-first-runaway or a convergence review", async () => {
    const { host, fake, wakes, runId } = scene(["NO_REPRO", "NO_REPRO", "NO_REPRO"]);

    await vi.waitFor(() => expect(settled(host, runId, fake)).toBe(true), { timeout: 5_000 });

    const [gate, ...others] = pendingOf(host, runId);
    expect(others).toEqual([]);
    expect(gate?.stepId).toBe("sh-sent-back");
    expect(gate?.gate.prompt).toContain("fix-proof did not reproduce (NO_REPRO)");
    expect(gate?.gate.prompt).not.toContain("fix-first-runaway");
    expect(wakes).toEqual(["fix-proof", "fix-proof"]);
    expect(stepIds(host, runId).filter((id) => id === FIX_FIRST_STEP || D8_STEP.test(id))).toEqual([]);
  });

  it("wakes the fixer on a reviewer FIX_FIRST after two NO_REPRO rounds, and merges the next head with no runaway", async () => {
    const { host, fake, wakes, runId } = scene(["NO_REPRO", "NO_REPRO", "FIX_FIRST"]);

    await vi.waitFor(() => expect(settled(host, runId, fake)).toBe(true), { timeout: 5_000 });

    expect(fake.pr(1).merged).toBe(true);
    expect(wakes).toEqual(["fix-proof", "fix-proof", "review"]);
    expect(stepIds(host, runId).filter((id) => id === FIX_FIRST_STEP)).toHaveLength(1);
    expect(stepIds(host, runId).filter((id) => D8_STEP.test(id))).toEqual([]);
  });
});

describe("a run recorded before TP-3900, which counted a NO_REPRO as a FIX_FIRST", () => {
  /** Writes the old record shape: a FIX_FIRST step right after each NO_REPRO round's publish. */
  function beforeTp3900(workflow: WorkflowDefinition): WorkflowDefinition {
    const legacy = (ctx: WorkflowContext): WorkflowContext => {
      const dispatch: WorkflowContext["dispatch"] = async (stepId, template, options) => {
        const done = await ctx.dispatch(stepId, template, options);
        const input = JSON.stringify(options?.vars ?? {});
        if (stepId.startsWith("sh-publish-review:") && input.includes(String.raw`\"outcome\":\"FIX_FIRST\"`)) await recordFixFirst(ctx, { repo: REPO, pr: 1, headSha: H1 });
        return done;
      };
      return new Proxy(ctx, { get: (target, key) => (key === "dispatch" ? dispatch : Reflect.get(target, key, target)) as unknown });
    };
    return { ...workflow, run: (ctx) => workflow.run(legacy(ctx)) };
  }

  it("replays the recorded FIX_FIRST step at its NO_REPRO round without diverging", async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "tp3900-")), "factory.db");
    const fake = greenPr();
    const store = shepherdStoreRef();
    const unhandled: ShepherdPhases = { ...scripted(["NO_REPRO"], { fake }).phases, wake: async () => ({ kind: "unhandled", reason: "no agent in this test" }) };
    const first = openHost(fake, store, beforeTp3900(shepherdPrWorkflow(unhandled)), dbPath);
    const runId = startRun(first, store);
    await vi.waitFor(() => expect(pendingOf(first, runId).map((gate) => gate.stepId)).toEqual(["sh-sent-back"]), { timeout: 5_000 });
    expect(stepIds(first, runId)).toContain(FIX_FIRST_STEP);
    first.close();

    const second = openHost(fake, store, shepherdPrWorkflow(unhandled), dbPath);
    await second.adopt();

    await vi.waitFor(() => expect(pendingOf(second, runId).length > 0 || second.runtime.status(runId)?.status === "recovery_required").toBe(true), { timeout: 5_000 });
    expect(second.runtime.status(runId)?.status).not.toBe("recovery_required");
    expect(pendingOf(second, runId).map((gate) => gate.stepId)).toEqual(["sh-sent-back"]);
  });
});

describe("D8's convergence review entry (TP-3900)", () => {
  const H2 = fakeSha("tp3900-h2");
  const recorded: string[] = [];
  const run = (overrides: Partial<FixFirstDemotionRun> = {}, next?: string): FixFirstDemotionRun => {
    const dispatch = async (stepId: string) => (recorded.push(stepId), { stepId, iteration: 0, agentId: null, signal: null, completedAt: "", data: { result: {} } });
    const ctx = partialFake<WorkflowContext>({ runId: "run-1", historyNext: () => next, dispatch: dispatch as unknown as WorkflowContext["dispatch"] });
    return { ...{ ctx, target: { repo: REPO, pr: 1 }, state: { waits: 0 } }, ...{ reviews: new Map(), fresh: new Set<string>(), fixFirstTrail: [] }, ...overrides };
  };
  const runaway = { escalation: "fix-first-runaway", detail: "the last at h" } as const;
  afterEach(() => void recorded.splice(0));

  it("leaves a runaway whose trail holds no reviewer FIX_FIRST to the owner gate, sending no convergence review", async () => {
    const noRepros = run({ fixFirstTrail: [{ headSha: H1, text: "", noRepro: true }, { headSha: H2, text: "", noRepro: true }] });

    const routed = await onFixFirstEscalated(noRepros, H2, runaway);

    expect(routed).toBeUndefined();
    expect(noRepros.fresh.size).toBe(0);
    expect(noRepros.convergedAt).toBeUndefined();
    expect(recorded).toEqual([]);
  });

  it("leaves a runaway at a head whose fix-proof said NO_REPRO to the owner gate, though a reviewer said FIX_FIRST earlier", async () => {
    const atNoRepro = run({ fixFirstTrail: [{ headSha: H1, text: "a finding" }], reviews: new Map<string, Verdict>([[H2, { kind: "NO_REPRO", headSha: H2, result: {} }]]) });

    const routed = await onFixFirstEscalated(atNoRepro, H2, runaway);

    expect(routed).toBeUndefined();
    expect(atNoRepro.fresh.size).toBe(0);
  });

  it("sends the convergence review for a trail of reviewer FIX_FIRSTs", async () => {
    const reviewed = run({ fixFirstTrail: [{ headSha: H1, text: "a finding" }] });

    const routed = await onFixFirstEscalated(reviewed, H2, runaway);

    expect(routed).toBe(false);
    expect([...reviewed.fresh]).toEqual([H2]);
    expect(recorded).toEqual([autoPassStepId("D8/convergence-review", H2)]);
  });

  it("replays a convergence review a record took at a NO_REPRO-only trail, so the run does not diverge", async () => {
    const replaying = run({ fixFirstTrail: [{ headSha: H1, text: "", noRepro: true }] }, autoPassStepId("D8/convergence-review", H2));

    const routed = await onFixFirstEscalated(replaying, H2, runaway);

    expect(routed).toBe(false);
    expect(recorded).toEqual([autoPassStepId("D8/convergence-review", H2)]);
  });
});
