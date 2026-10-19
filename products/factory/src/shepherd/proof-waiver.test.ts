import type { ServiceAnswer } from "@titan-design/agent-dispatch";
import { formatResultLine, type FixProofResult, type Verdict as ProofVerdict } from "@titan-design/fix-proof";
import { fakeGitHub, fakeSha, githubPort, successRun, type CheckRun } from "@titan-design/github";
import type { GateResolver } from "@titan-design/hitl";
import type { ReviewerAgent, ReviewerDispatch, ReviewerReader } from "@titan-design/review-panel";
import type { SourceTextLocator } from "@titan-design/session-read";
import type { StepRoute, WorkflowContext } from "@titan-design/workflow";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { defineWorkflow } from "../definition.js";
import { notifyTick, type GateNotifyPorts } from "../gate-notify.js";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { REPO, gateId, gateOpened } from "../test-support/land.js";
import { OWNER } from "../test-support/resolver.js";
import { factoryRoutesFor } from "../workflows.js";
import { landPrWorkflow } from "../workflows/land-pr.js";
import { sleep } from "../workflows/land.js";
import { shepherdEventMigration } from "./events.js";
import { FIX_PROOF_CHECK } from "./fix-proof.js";
import { SEAT_NOTICE_STEPS, seatNoticeRoute, unhandledSendBack } from "./gate-route.js";
import type { GateRun } from "./gates.js";
import type { ShepherdDeps, ShepherdPhases, Verdict } from "./phases.js";
import { OWNER_GATE_POLICY, type EffectivePolicy } from "./policy.js";
import { shepherdPrWorkflow } from "./pr.js";
import { proofWaiverMigration } from "./proof-waiver.js";
import { REVIEW_STEPS, reviewPhase, reviewRoutes } from "./review.js";
import { holdReviewerMigration, holdSatisfiedMigration, holdSlotsMigration, shepherdMigration, shepherdStoreRef, sliceMigration, type ShepherdStoreRef } from "./store.js";

const A = fakeSha("waiver-head-a");
const B = fakeSha("waiver-head-b");
const BASE = fakeSha("waiver-base");
const AUTO: EffectivePolicy = { merge: "auto", mergeMethod: "squash", fixer: true, seat: "trusted-seat" };
const DECIDER: GateResolver = { class: "decider", id: "decider-1", channel: "agent-chat" };
const JOB: Record<string, number> = { [A]: 77, [B]: 78 };

const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

function proofLine(head: string, verdict: ProofVerdict): string {
  const counts: FixProofResult["counts"] = { reproduces: verdict === "reproduced" ? 1 : 0, "passes-on-base": 0, "new-api": 0, "fails-on-head": 0, "not-run": 0 };
  return formatResultLine({ head, mergeBase: BASE, verdict, counts, notCollected: [], deletedTests: [], configEdited: false, tests: [], truncated: false });
}

const fixProofRun = (head: string): CheckRun => ({ ...successRun(FIX_PROOF_CHECK, JOB[head]!), headSha: head, pullRequests: [{ number: 1, baseRef: "main" }] });

const locatorIn = (nativeId: string): SourceTextLocator => ({
  source: { sourceId: nativeId, harness: "claude-code", format: "jsonl", formatVersion: null, path: `${nativeId}.jsonl`, namespace: "test", conversation: { harness: "claude-code", namespace: "test", nativeId }, provenance: { kind: "claude-code-transcript", legacySessionId: nativeId } },
  evidence: { line: { sourceId: nativeId, byteOffset: 0, byteLength: 0, contentHash: "", lineNumber: null, nativeOrdinal: null }, subrecord: { index: 0, path: [] } },
  selector: { kind: "subrecord-text", path: ["message", "content", 0, "text"] },
});

/** A dispatch whose every spawned reviewer says MERGE at the head it was asked about. */
function mergingReviewers(now: () => number): { dispatch: ReviewerDispatch; reader: ReviewerReader; spawns: string[]; briefs: Map<string, string> } {
  const agents: ReviewerAgent[] = [];
  const spawns: string[] = [];
  const briefs = new Map<string, string>();
  const dispatch: ReviewerDispatch = {
    roster: async () => [...agents],
    spawn: async (name, brief, target) => {
      spawns.push(target.head);
      briefs.set(target.head, brief);
      agents.push({ name, agentId: `agent-${name}`, sessionId: `session-${name}`, presence: "live", spawnedBy: null, predecessor: null });
    },
    resume: async () => undefined,
  };
  const reader: ReviewerReader = {
    read: async (input) =>
      agents.filter((who) => who.agentId === input.reviewerAgentId).map((who) => ({ agentId: who.agentId, sessionId: who.sessionId, writtenAt: now() + 1, text: `Verdict: MERGE\nPR: ${REPO}#1\nHead: ${input.head}\n`, locator: locatorIn(who.sessionId) })),
  };
  return { dispatch, reader, spawns, briefs };
}

/** The run reviews each head in turn; a NO_REPRO takes the unhandled send-back, and a waived head is reviewed again. */
async function reviewHeads(ctx: WorkflowContext, heads: readonly string[], verdicts: Verdict[]): Promise<void> {
  const run: GateRun = { ctx, target: { repo: REPO, pr: 1 }, state: { waits: 0 }, reviews: new Map() };
  for (const head of heads) {
    const verdict = await reviewPhase(ctx, { repo: REPO, pr: 1, round: 0, headSha: head });
    verdicts.push(verdict);
    if (verdict.kind === "NO_REPRO" && (await unhandledSendBack(run, verdict.kind, head)) === undefined) verdicts.push(await reviewPhase(ctx, { repo: REPO, pr: 1, round: 1, headSha: head }));
  }
}

/** Real review steps over a fake GitHub where a head's fix-proof is vacuous unless `reproducedAt` names it; `answer` settles each sh-sent-back gate. */
async function reviewScene(heads: readonly string[], answer: (host: FactoryHost, runId: string) => Promise<void>, reproducedAt: readonly string[] = []) {
  const fake = fakeGitHub();
  fake.addPr({ headSha: heads[0]!, mergeSha: fakeSha("waiver-merge") });
  fake.prFiles.set(1, [{ path: "packages/x/src/a.test.ts", status: "modified" }]);
  for (const head of heads) {
    fake.setRuns(head, [successRun("validate", 1), successRun("dag-check", 2), fixProofRun(head)]);
    fake.jobLogs.set(JOB[head]!, `2026-10-18T00:00:00.0000000Z ${proofLine(head, reproducedAt.includes(head) ? "reproduced" : "vacuous")}`);
  }
  let clock = 10_000;
  const store = shepherdStoreRef();
  const deps: ShepherdDeps = { port: githubPort(fake.wire), store, now: () => clock, sleep: async (ms) => void (clock += ms), pollMs: 1_000, agentChatBin: "agent-chat", reviewCheckouts: { root: "/data/reviews", remove: async () => undefined } };
  const reviewers = mergingReviewers(() => clock);
  const inputs: Record<string, unknown> = {};
  const recorded = [...reviewRoutes(deps, { reader: reviewers.reader, dispatch: reviewers.dispatch, timeoutMs: 5_000 }), seatNoticeRoute(deps.now, undefined, deps.sleep)].map((route): StepRoute => ({ ...route, runner: { run: (step) => ((inputs[step.stepId] = JSON.parse(step.prompt)), route.runner.run(step)) } }));
  const routes = Object.assign(recorded, { database: { extraMigrations: [shepherdMigration(4), sliceMigration(8), holdReviewerMigration(9), holdSatisfiedMigration(11), shepherdEventMigration(16), holdSlotsMigration(19), proofWaiverMigration(32)], bind: store.bind } });
  const verdicts: Verdict[] = [];
  const steps = [...REVIEW_STEPS, ...SEAT_NOTICE_STEPS, { id: "sh-sent-back", kind: "assisted" as const }];
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [defineWorkflow({ name: "waiver-test", steps, run: (ctx) => reviewHeads(ctx, heads, verdicts) })], routes, gatePollMs: 5 });
  hosts.push(host);
  const runId = host.runtime.start("waiver-test", { policy: JSON.stringify(AUTO) });
  store.get().register({ repo: REPO, pr: 1, runId, task: "demo: fix a flaky test", implementer: "impl-a", policy: OWNER_GATE_POLICY, kind: "correctness" });
  await answer(host, runId);
  await host.runtime.wait(runId);
  return { verdicts, spawns: reviewers.spawns, briefs: reviewers.briefs, inputs, store, runId };
}

const waiveAt = (head: string) => async (host: FactoryHost, runId: string) => {
  await gateOpened(host, gateId(runId, "sh-sent-back"));
  host.runtime.signal(runId, "sh-sent-back", { decision: "waive-proof", headSha: head }, OWNER);
};

const waiveThenAbandon = async (host: FactoryHost, runId: string) => {
  await waiveAt(A)(host, runId);
  await gateOpened(host, gateId(runId, "sh-sent-back", 1));
  host.runtime.signal(runId, "sh-sent-back", { decision: "abandon" }, OWNER);
};

const DecidedEvidence = z.looseObject({ record: z.looseObject({ decision: z.looseObject({ outcome: z.string(), reason: z.string() }) }) });
const evidenceAt = (verdict: Verdict | undefined) => (verdict?.kind === "MERGE" ? DecidedEvidence.parse(verdict.evidence) : undefined);

describe("an owner's waive-proof on a NO_REPRO send-back", () => {
  it("lets the review at the waived head proceed, and its MERGE goes to the owner gate even under an auto policy", async () => {
    const { verdicts, spawns, inputs, store, runId } = await reviewScene([A], waiveAt(A));

    expect(verdicts.map((verdict) => verdict.kind)).toEqual(["NO_REPRO", "MERGE"]);
    expect(spawns).toEqual([A]);
    expect(store.get().proofWaivers().waivedAt(runId, A)).toBe(true);
    expect(inputs[`sh-merge-evidence:${A}`]).toMatchObject({ seatGrants: [], grantWithheld: { policy: null, proof: `waived by owner at ${A}` } });
    const evidence = evidenceAt(verdicts[1]);
    expect(evidence?.record.decision.outcome).toBe("gate");
    expect(evidence?.record.decision.reason).toContain(`merge-on-green-approve withheld: proof standing unverified: waived by owner at ${A}`);
  });

  it("re-gates a new head: the waiver at head A does not let head B's NO_REPRO reach a reviewer", async () => {
    const { verdicts, spawns, store, runId } = await reviewScene([A, B], waiveThenAbandon);

    expect(verdicts.map((verdict) => [verdict.kind, "headSha" in verdict ? verdict.headSha : undefined])).toEqual([
      ["NO_REPRO", A],
      ["MERGE", A],
      ["NO_REPRO", B],
    ]);
    expect(spawns).toEqual([A]);
    expect(store.get().proofWaivers().waivedAt(runId, B)).toBe(false);
  });
});

describe("the reviewer brief after an owner's waive-proof", () => {
  it("tells the reviewer at the waived head that the fix-proof is waived by the owner", async () => {
    const { briefs, inputs } = await reviewScene([A], waiveAt(A));

    expect(inputs[`sh-review:${A}`]).toMatchObject({ fixProofWaivedAt: A });
    expect(briefs.get(A)).toContain("fix-proof waived by owner");
    expect(briefs.get(A)).not.toContain("verdict for this head: vacuous");
  });

  it("says nothing of the waiver at head A to the reviewer of a later head B", async () => {
    const { briefs, inputs, spawns } = await reviewScene([A, B], waiveAt(A), [B]);

    expect(spawns).toEqual([A, B]);
    expect(inputs[`sh-review:${B}`]).not.toHaveProperty("fixProofWaivedAt");
    expect(briefs.get(B)).toContain("verdict for this head: reproduced");
    expect(briefs.get(B)).not.toContain("waived");
  });

  it("says nothing of a waiver to the reviewer of a head no one waived", async () => {
    const { briefs, inputs } = await reviewScene([B], async () => undefined, [B]);

    expect(inputs[`sh-review:${B}`]).not.toHaveProperty("fixProofWaivedAt");
    expect(briefs.get(B)).not.toContain("waived");
  });
});

/** A shepherd-pr run over every factory route, with the review and wake phases scripted. */
function shepherdWorld(review: (headSha: string, round: number) => Verdict) {
  const fake = fakeGitHub();
  fake.onGetPr = (pr) => fake.setRuns(pr.headSha, [successRun("validate", 1), successRun("dag-check", 2)]);
  fake.addPr({ headSha: A });
  let clock = 0;
  const ref: ShepherdStoreRef = shepherdStoreRef();
  const reviews: [string, number][] = [];
  const phases: ShepherdPhases = {
    wake: async () => ({ kind: "unhandled", reason: "no agent in this test" }),
    review: async (_ctx, request) => (reviews.push([request.headSha, request.round]), review(request.headSha, reviews.length)),
  };
  const routes = factoryRoutesFor({ port: githubPort(fake.wire), store: ref, now: () => clock, sleep: async (ms, signal) => ((clock += ms), sleep(1, signal)), registry: async () => "trusted", versions: async () => true });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [shepherdPrWorkflow(phases), landPrWorkflow()], routes, gatePollMs: 5 });
  hosts.push(host);
  const runId = host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", policy: JSON.stringify(OWNER_GATE_POLICY) });
  ref.get().register({ repo: REPO, pr: 1, runId, task: "demo/1", implementer: "impl-a", policy: OWNER_GATE_POLICY });
  return { host, runId, reviews, ref };
}

/** gateNotify over the host, where agent-chat answers every ask it filed with `answer`. */
function relayedAnswer(host: FactoryHost, answer: Pick<ServiceAnswer, "text" | "provenance">): GateNotifyPorts {
  const asked: string[] = [];
  return {
    label: "titan-factory",
    resolverClass: "owner-remote",
    pendingGates: () => host.gates.listPending(),
    getGate: (id) => host.gates.get(id),
    resolve: (id, payload, resolver) => void host.gates.resolve(id, payload, resolver),
    asks: host.asks,
    askHuman: async () => (asked.push(`q${asked.length + 1}`), asked.at(-1)!),
    readAnswers: async () => ({ answers: asked.map((questionId, i) => ({ msgId: `a${i + 1}`, questionId, outcome: "answered", by: "human", at: i, ...answer })) }),
    dismissAsk: async () => undefined,
    log: () => undefined,
  };
}

const NO_REPRO: Verdict = { kind: "NO_REPRO", headSha: A, result: { verdict: "vacuous" } };
const optionsOf = (host: FactoryHost, id: string) => host.gates.get(id)?.questions?.flatMap((question) => question.options.map((option) => ({ id: option.id, recommended: option.recommended === true })));

describe("waive-proof in a shepherd-pr run", () => {
  it("offers waive-proof, never recommended, on a NO_REPRO send-back, and a waived head is reviewed again in the next round", async () => {
    const w = shepherdWorld((headSha, call) => (call === 1 ? NO_REPRO : { kind: "MERGE", headSha, evidence: {} }));
    const sentBack = gateId(w.runId, "sh-sent-back");
    await gateOpened(w.host, sentBack);

    expect(optionsOf(w.host, sentBack)).toEqual([
      { id: "await-new-head", recommended: true },
      { id: "abandon", recommended: false },
      { id: "waive-proof", recommended: false },
    ]);
    w.host.runtime.signal(w.runId, "sh-sent-back", { decision: "waive-proof", headSha: A }, OWNER);
    await gateOpened(w.host, gateId(w.runId, "approve-merge"));

    expect(w.reviews.map(([head]) => head)).toEqual([A, A]);
    expect(w.ref.get().proofWaivers().waivedAt(w.runId, A)).toBe(true);
  });

  it("refuses a waive-proof that names no head or another head, so the gate stays open", async () => {
    const w = shepherdWorld(() => NO_REPRO);
    const sentBack = gateId(w.runId, "sh-sent-back");
    await gateOpened(w.host, sentBack);

    expect(() => w.host.runtime.signal(w.runId, "sh-sent-back", { decision: "waive-proof" }, OWNER)).toThrow();
    expect(() => w.host.runtime.signal(w.runId, "sh-sent-back", { decision: "waive-proof", headSha: B }, OWNER)).toThrow();
    expect(w.host.gates.get(sentBack)?.status).toBe("pending");
  });

  it("does not offer waive-proof on a FIX_FIRST send-back, and the store refuses one", async () => {
    const w = shepherdWorld((headSha) => ({ kind: "FIX_FIRST", headSha, text: "missing test" }));
    const sentBack = gateId(w.runId, "sh-sent-back");
    await gateOpened(w.host, sentBack);

    expect(optionsOf(w.host, sentBack)?.map((option) => option.id)).toEqual(["await-new-head", "abandon"]);
    expect(() => w.host.runtime.signal(w.runId, "sh-sent-back", { decision: "waive-proof", headSha: A }, OWNER)).toThrow();
    expect(w.host.gates.get(sentBack)?.status).toBe("pending");
  });

  it("refuses a decided waive-proof relayed over agent-chat with no waiver written, then takes the owner's own tap", async () => {
    const w = shepherdWorld((headSha, call) => (call === 1 ? NO_REPRO : { kind: "MERGE", headSha, evidence: {} }));
    const sentBack = gateId(w.runId, "sh-sent-back");
    await gateOpened(w.host, sentBack);
    const relay = relayedAnswer(w.host, { text: "waive-proof", provenance: "decided" });

    await notifyTick(relay);
    await notifyTick(relay);

    expect(w.host.asks.get(sentBack)?.state).toBe("refused");
    expect(w.host.gates.get(sentBack)?.status).toBe("pending");
    expect(w.ref.get().proofWaivers().waivedAt(w.runId, A)).toBe(false);

    w.host.runtime.signal(w.runId, "sh-sent-back", { decision: "waive-proof", headSha: A }, OWNER);
    await gateOpened(w.host, gateId(w.runId, "approve-merge"));

    expect(w.ref.get().proofWaivers().waivedAt(w.runId, A)).toBe(true);
  });

  it("refuses a decider's waive-proof: only the owner may waive, so no waiver is written and the head is not reviewed again", async () => {
    const w = shepherdWorld(() => NO_REPRO);
    const sentBack = gateId(w.runId, "sh-sent-back");
    await gateOpened(w.host, sentBack);

    expect(() => w.host.runtime.signal(w.runId, "sh-sent-back", { decision: "waive-proof", headSha: A }, DECIDER)).toThrow(/decider/);
    expect(w.host.gates.get(sentBack)?.status).toBe("pending");
    expect(w.ref.get().proofWaivers().waivedAt(w.runId, A)).toBe(false);
    expect(w.reviews).toHaveLength(1);
  });
});
