import { fakeGitHub, fakeSha, githubPort, successRun, type CheckRun } from "@titan-design/github";
import { partialFake } from "@titan-design/test-kit";
import type { DispatchOptions, StepResult, WorkflowContext } from "@titan-design/workflow";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { approveMergeDecision } from "../gate-brief.js";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { gateId, gateOpened } from "../test-support/land.js";
import { factoryRoutesFor } from "../workflows.js";
import { sleep } from "../workflows/land.js";
import { GATE_DEMOTIONS } from "./auto-pass.js";
import { LeaveLand } from "./leave-land.js";
import { askingOnlyOverMerge, type NoMergeRun } from "./no-merge-no-ask.js";
import type { ShepherdPhases, Verdict } from "./phases.js";
import type { EffectivePolicy } from "./policy.js";
import { shepherdPrWorkflow } from "./pr.js";
import { shepherdStoreRef } from "./store.js";

const REPO = "octo/demo";
const HEAD = fakeSha("no-merge-head");
const GREEN: CheckRun[] = [successRun("validate", 1), successRun("dag-check", 2)];
const VISUAL: EffectivePolicy = { merge: "owner-gate", ownerGateReason: "gate-2-visual", mergeMethod: "squash", fixer: true, seat: "design-seat", visualPaths: ["packages/ui/**"] };
const OLD_SUMMARY = "No reviewer MERGE at this head";

const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

/** A visual registration on a green PR whose every review answers `verdict`. */
function visualWorld(verdict: (headSha: string) => Verdict) {
  const fake = fakeGitHub();
  fake.onGetPr = (pr) => fake.setRuns(pr.headSha, GREEN);
  fake.addPr({ headSha: HEAD });
  const reviews: string[] = [];
  const phases: ShepherdPhases = {
    wake: async () => ({ kind: "unhandled", reason: "no fixer in this replay" }),
    review: async (_ctx, request) => (reviews.push(request.headSha), verdict(request.headSha)),
  };
  const store = shepherdStoreRef();
  let clock = 0;
  const routes = factoryRoutesFor({ port: githubPort(fake.wire), store, now: () => clock, sleep: async (ms, signal) => ((clock += ms), sleep(1, signal)), park: async () => ({ lines: [] }) });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [shepherdPrWorkflow(phases)], routes, gatePollMs: 5 });
  hosts.push(host);
  const runId = host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", policy: JSON.stringify(VISUAL) });
  store.get().register({ repo: REPO, pr: 1, runId, task: "demo/1", implementer: "impl-a", policy: VISUAL });
  return { host, runId, reviews };
}

describe("a visual head with a reviewer MERGE (td#923's shape)", () => {
  it("still opens approve-merge, recommending the merge, with no extra review", async () => {
    const world = visualWorld((headSha) => ({ kind: "MERGE", headSha, evidence: {} }));
    const gate = gateId(world.runId, "approve-merge");

    await gateOpened(world.host, gate);

    expect(world.reviews).toEqual([HEAD]);
    expect(world.host.gates.get(gate)?.prompt).toContain(`at head ${HEAD}`);
    expect(world.host.gates.get(gate)?.summary).toContain("Reviewer said MERGE at this head; recommend merge.");
  });
});

const StepInput = z.record(z.string(), z.unknown());
const PROMPT = `Merge PR #1 in ${REPO} at head ${HEAD}? CI is green. Policy shepherd-seat/design-seat: seat design-seat policy owner-gate (gate-2-visual) waits for the owner on merge`;

/** A run whose code steps answer `noticeSent` for the seat notice and echo every other input; `asked` lists the prompts that reached the gate. */
function guardRun(verdict: Verdict | undefined, noticeSent = true) {
  const steps: { stepId: string; input: Record<string, unknown> }[] = [];
  const asked: string[] = [];
  async function dispatch<T extends Record<string, unknown>>(stepId: string, _template: string, options: DispatchOptions<T> = {}): Promise<StepResult<T>> {
    const input = StepInput.parse(JSON.parse(Object.values(options.vars ?? {})[0] ?? "{}"));
    steps.push({ stepId, input });
    const result = stepId.startsWith("sh-seat-notice") ? { sent: noticeSent, detail: noticeSent ? "sent" : "no seat notice is wired" } : { ...input, commentId: 7, headSha: fakeSha("pushed"), state: "open" };
    return { stepId, iteration: 0, agentId: null, signal: null, completedAt: "", data: options.schema?.parse({ result }) };
  }
  const run: NoMergeRun = {
    ctx: partialFake<WorkflowContext>({ runId: "run-1", param: () => undefined, dispatch }),
    ...{ target: { repo: REPO, pr: 1 }, state: { waits: 0 }, reviews: new Map(verdict ? [[HEAD, verdict]] : []), fresh: new Set<string>(), unreviewedAsks: new Set<string>() },
  };
  const assisted: WorkflowContext["assisted"] = async (stepId, prompt) => (asked.push(prompt), { stepId, iteration: 0, agentId: null, signal: null, completedAt: "", data: {} });
  return { run, steps, asked, ask: askingOnlyOverMerge(run, assisted) };
}

const TIMED_OUT: Verdict = { kind: "none", cause: "timeout", reason: "no verdict" };
const FIX_FIRST: Verdict = { kind: "FIX_FIRST", headSha: HEAD, text: "rename" };
const PANEL_SILENT: Verdict = { kind: "none", cause: "no-verdict", reason: "a blocking panel member gave no verdict" };
const MERGE_ELSEWHERE: Verdict = { kind: "MERGE", headSha: fakeSha("older"), evidence: {} };
const MERGE_HERE: Verdict = { kind: "MERGE", headSha: HEAD, evidence: {} };
const REVIEWER = { agentId: "agent-rv-1", sessionId: "session-rv-1" };
const SEAT_HELD: Verdict = { kind: "none", reason: "the seat said WAIT", seatHeld: { head: HEAD, locator: {}, reviewer: REVIEWER, dispatchedReviewer: REVIEWER, merge: {} } };
const UNWIRED: Verdict = { kind: "none" };

describe("the approve-merge guard", () => {
  it("td#808's shape: a visual head whose review timed out gets one fresh reviewer, recording why, and asks no one", async () => {
    const { run, steps, asked, ask } = guardRun(TIMED_OUT);

    await expect(ask("approve-merge", PROMPT)).rejects.toBeInstanceOf(LeaveLand);

    expect(asked).toEqual([]);
    expect(run.reviews.has(HEAD)).toBe(false);
    expect(run.fresh.has(HEAD)).toBe(true);
    expect(steps.map((step) => step.input["rule"])).toEqual(["R4/fresh-reviewer"]);
    expect(steps[0]?.input["evidence"]).toEqual([`head ${HEAD}`, "verdict held there: none"]);
  });

  it("tells the repo's seat after the fresh reviewer gave no MERGE either, and waits for a new head", async () => {
    const { run, steps, asked, ask } = guardRun(TIMED_OUT);
    await expect(ask("approve-merge", PROMPT)).rejects.toBeInstanceOf(LeaveLand);
    run.reviews.set(HEAD, TIMED_OUT);

    await expect(ask("approve-merge", PROMPT)).rejects.toBeInstanceOf(LeaveLand);

    expect(asked).toEqual([]);
    expect(steps.map((step) => step.stepId)).toEqual([`sh-auto-pass:R4-fresh-reviewer:${HEAD}`, "sh-seat-notice", "await-new-head:0"]);
    expect(steps[1]?.input).toMatchObject({ gate: "unreviewed", headSha: HEAD });
  });

  it("opens the gate only when the seat notice after the fresh reviewer could not go out, saying why", async () => {
    const { run, asked, ask } = guardRun(TIMED_OUT, false);
    await expect(ask("approve-merge", PROMPT)).rejects.toBeInstanceOf(LeaveLand);
    run.reviews.set(HEAD, TIMED_OUT);

    await ask("approve-merge", PROMPT);

    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("Unreviewed: no reviewer MERGE stands at this head after a fresh review");
    expect(asked[0]).toContain("(no seat notice is wired)");
  });

  it.each([
    ["a FIX_FIRST", FIX_FIRST],
    ["a panel whose blocking member gave no verdict", PANEL_SILENT],
    ["a MERGE written at another head", MERGE_ELSEWHERE],
    ["no review at all", undefined],
  ])("does not open the gate over %s", async (_case, verdict) => {
    const { asked, ask } = guardRun(verdict);

    await expect(ask("approve-merge", PROMPT)).rejects.toBeInstanceOf(LeaveLand);

    expect(asked).toEqual([]);
  });

  it.each([
    ["a reviewer MERGE at the head", MERGE_HERE, PROMPT],
    ["Shepherd's own MERGE a seat holds there", SEAT_HELD, PROMPT],
    ["a run with no reviewer wired", UNWIRED, PROMPT],
    ["a route escalation, which keeps its D7 or D8 path", TIMED_OUT, PROMPT.replace("shepherd-seat/design-seat", "shepherd-route/failed-rounds")],
  ])("opens the gate as before over %s", async (_case, verdict, prompt) => {
    const { asked, ask } = guardRun(verdict);

    await ask("approve-merge", prompt);

    expect(asked).toEqual([prompt]);
  });

  it("leaves every other gate alone", async () => {
    const { asked, ask } = guardRun(TIMED_OUT);

    await ask("sh-sent-back", PROMPT);

    expect(asked).toEqual([PROMPT]);
  });

  it("opens the gate as before with the rule reverted", async () => {
    GATE_DEMOTIONS.noMergeNoAsk = false;
    try {
      const { asked, ask } = guardRun(TIMED_OUT);

      await ask("approve-merge", PROMPT);

      expect(asked).toEqual([PROMPT]);
    } finally {
      GATE_DEMOTIONS.noMergeNoAsk = true;
    }
  });
});

describe("the approve-merge brief over a head with no MERGE", () => {
  it("does not claim no reviewer said MERGE, since a panel member may have", () => {
    const { brief } = approveMergeDecision({ repo: REPO, pr: 1, headSha: HEAD, reason: "the last ended with a blocking panel member gave no verdict", reviewedMerge: false });

    expect(brief.summary).not.toContain(OLD_SUMMARY);
    expect(brief.summary).toContain("Shepherd holds no complete MERGE review at this head");
  });
});
