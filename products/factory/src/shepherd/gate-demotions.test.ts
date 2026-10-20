import { fakeGitHub, fakeSha, githubPort, successRun, type CheckRun, type PrFile } from "@titan-design/github";
import type { SourceTextLocator } from "@titan-design/session-read";
import { partialFake } from "@titan-design/test-kit";
import type { DispatchOptions, StepResult, WorkflowContext } from "@titan-design/workflow";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { gateId, gateOpened } from "../test-support/land.js";
import { factoryRoutesFor } from "../workflows.js";
import { sleep } from "../workflows/land.js";
import { GATE_DEMOTIONS, autoPassComment, autoPassesOf } from "./auto-pass.js";
import type { ExitNoticePorts } from "./exit-notice.js";
import { demoteFailedRounds, noteReviewerAccount, onEscalated, type FailedRoundsRun } from "./failed-rounds-demotion.js";
import { LeaveLand } from "./leave-land.js";
import { mergeEvidence, noFreezeStoreUntilTp523, type MergeEvidence, type MergeEvidenceInput } from "./merge-facts.js";
import { shepherdGatePolicy, type EffectivePolicy } from "./policy.js";
import { shepherdMainCi } from "./post-merge.js";
import { SEAT_HELD_ROUNDS_WORDS, fixFirstEscalation, type Escalated } from "./route-table.js";
import type { ObservedPr } from "./observe.js";
import { countRound, type Routed } from "./routed.js";
import type { ShepherdPhases, Verdict } from "./phases.js";
import { shepherdPrWorkflow } from "./pr.js";
import { shepherdStoreRef } from "./store.js";

const REPO = "octo/demo";
const HEAD = fakeSha("demotion-head");
const REVIEWER = { agentId: "agent-rv-1", sessionId: "session-rv-1" };
const VISUAL_PATHS = ["packages/ui/**"];
const locator: SourceTextLocator = {
  source: {
    ...{ sourceId: "transcript-1", harness: "claude-code", format: "jsonl", formatVersion: null, path: "/transcripts/transcript-1.jsonl", namespace: "test" },
    ...{ conversation: { harness: "claude-code", namespace: "test", nativeId: "session-rv-1" }, provenance: { kind: "native", name: "test" } },
  },
  evidence: {
    line: { sourceId: "transcript-1", byteOffset: 0, byteLength: 1, contentHash: "0".repeat(64), lineNumber: 1, nativeOrdinal: null },
    subrecord: { index: 0, path: [] },
  },
  selector: { kind: "subrecord-text", path: ["message", "content", 0, "text"] },
};

const input: MergeEvidenceInput = {
  ...{ runId: "run-1", repo: REPO, pr: 1, head: HEAD, verdict: { value: "MERGE", head: HEAD, locator } },
  ...{ resolver: REVIEWER, dispatchedReviewer: REVIEWER, seatGrants: ["merge-on-green-approve"], visualPaths: VISUAL_PATHS },
};

const STORY: PrFile[] = [{ path: "packages/ui/src/Button.stories.tsx", status: "modified" }];
const GREEN: CheckRun[] = [successRun("validate", 1), successRun("dag-check", 2)];

async function evidenceFor(files: PrFile[]): Promise<MergeEvidence> {
  const fake = fakeGitHub();
  fake.addPr({ headSha: HEAD, mergeSha: fakeSha("test-merge") });
  fake.setRuns(HEAD, GREEN);
  fake.prFiles.set(1, files);
  return mergeEvidence(githubPort(fake.wire), input, noFreezeStoreUntilTp523, { kind: "feature" });
}

const GATE2: EffectivePolicy = { merge: "owner-gate", ownerGateReason: "gate-2-visual", mergeMethod: "squash", fixer: true, seat: "design-seat", visualPaths: VISUAL_PATHS };
const mergeAt = (evidence: MergeEvidence): ((headSha: string) => Verdict) => () => ({ kind: "MERGE", headSha: HEAD, evidence });

describe("D2 is unchanged (cut to TP-3716)", () => {
  it("a gate-2-visual registration still waits for the owner on a story-only head with a MERGE and CI green there", async () => {
    const evidence = await evidenceFor(STORY);

    expect(shepherdGatePolicy(GATE2, mergeAt(evidence)).decide("merge", { headSha: HEAD })).toMatchObject({ outcome: "gate", rule: { table: "shepherd-seat", rowId: "design-seat" } });
  });
});

const StepInput = z.record(z.string(), z.unknown());

interface Recorded {
  ctx: WorkflowContext;
  steps: { stepId: string; input: Record<string, unknown> }[];
  asked: string[];
}

/** A context whose code steps answer `result` and record their input, and whose gates are acknowledged at once. */
function recordingCtx(result: (stepId: string, input: Record<string, unknown>) => unknown = (_id, input) => ({ ...input, commentId: 7 })): Recorded {
  const steps: Recorded["steps"] = [];
  const asked: string[] = [];
  async function dispatch<T extends Record<string, unknown>>(stepId: string, _template: string, options: DispatchOptions<T> = {}): Promise<StepResult<T>> {
    const input = StepInput.parse(JSON.parse(Object.values(options.vars ?? {})[0] ?? "{}"));
    steps.push({ stepId, input });
    return { stepId, iteration: 0, agentId: null, signal: null, completedAt: "", data: options.schema?.parse({ result: result(stepId, input) }) };
  }
  const assisted: WorkflowContext["assisted"] = async (stepId, _prompt, options) => {
    asked.push(stepId);
    const data = StepInput.parse(options?.schema?.parse({ decision: "acknowledged", mergeSha: MERGED }) ?? {});
    return { stepId, iteration: 0, agentId: null, signal: null, completedAt: "", data };
  };
  return { ctx: partialFake<WorkflowContext>({ runId: "run-1", param: () => undefined, dispatch, assisted }), steps, asked };
}

const FAILED: Escalated = { escalation: "failed-rounds", detail: `the last at ${HEAD} ended with no reviewer verdict` };
const INFRA: Escalated = { ...FAILED, infraOnly: true };

function d7Run(over: Partial<FailedRoundsRun> = {}): FailedRoundsRun & Recorded {
  return {
    ...recordingCtx(),
    ...{ target: { repo: REPO, pr: 1 }, state: { waits: 0 }, reviews: new Map(), fresh: new Set<string>(), escalations: new Map(), failedRounds: 3 },
    ...{ failedOutcomes: ["timeout", "no-verdict", "throttled"], fallbackReviewed: false },
    ...over,
  };
}

const silentRound: Routed = { headSha: HEAD, verdict: { kind: "none" }, observed: partialFake<ObservedPr>(), outcome: "timeout", route: "fresh-reviewer" };

describe("D7: failed review rounds", () => {
  it("dispatch one fresh reviewer, not the owner, when every round failed on infrastructure, recording the rule and evidence", async () => {
    const run = d7Run();

    const routed = await demoteFailedRounds(run, HEAD, INFRA);

    expect(routed).toEqual({ route: "review-again" });
    expect(run.fresh.has(HEAD)).toBe(true);
    expect(run.fallbackReviewed).toBe(true);
    expect(run.steps).toHaveLength(1);
    expect(run.steps[0]).toMatchObject({ stepId: `sh-auto-pass:D7-fallback-reviewer:${HEAD}`, input: { rule: "D7/fallback-reviewer", headSha: HEAD } });
    expect(run.steps[0]?.input["evidence"]).toEqual([`head ${HEAD}`, "failed rounds: timeout, no-verdict, throttled"]);
  });

  it("review a head holding a carried MERGE and a seat request again after three infra failures, never merging it", async () => {
    const evidence = await evidenceFor([{ path: "src/x.ts", status: "modified" }]);
    const carried: Verdict = { kind: "MERGE", headSha: HEAD, evidence: { ...evidence, merge: { ...evidence.merge, carry: { fromHead: fakeSha("older"), head: HEAD, headTree: "t", mergeTree: "t" } } } };
    const run = { ...d7Run({ failedRounds: 0, failedOutcomes: [] }), merged: new Map([[HEAD, carried]]), trail: { seatAsked: new Set([HEAD]) } };
    run.reviews.set(HEAD, carried);
    const counts = { ...run, throttledRounds: 1, closer: { streak: 0 }, seatHeldRounds: new Map(), fixFirstTrail: [] };
    await countRound(counts, silentRound);
    await countRound(counts, silentRound);
    const escalated = await countRound(counts, silentRound);

    const goesToMerge = await onEscalated({ ...run, failedRounds: counts.failedRounds, failedOutcomes: counts.failedOutcomes }, HEAD, escalated!);

    expect(escalated).toMatchObject({ escalation: "failed-rounds", infraOnly: true });
    expect(goesToMerge).toBe(false);
    expect(run.reviews.has(HEAD)).toBe(false);
    expect(run.fresh.has(HEAD)).toBe(true);
    expect(run.steps.map((recorded) => recorded.input["rule"])).toEqual(["D7/fallback-reviewer"]);
  });

  it("route a failed fallback reviewer to an ops notice, not the owner, saying so", async () => {
    const run = d7Run({ fallbackReviewed: true });

    const routed = await demoteFailedRounds(run, HEAD, INFRA);

    expect(routed).toEqual({ route: "notice", to: "review-infra", escalated: { ...INFRA, detail: `${INFRA.detail}; the fallback fresh reviewer failed too` } });
    expect(run.steps).toEqual([]);
  });

  it("ask the owner once the fallback reviewer has failed too with the ops notice reverted", async () => {
    const run = d7Run({ fallbackReviewed: true });

    const routed = await demoteFailedRounds(run, HEAD, INFRA, { ...GATE_DEMOTIONS, failedFallback: false });

    expect(routed).toEqual({ route: "gate", escalated: { ...INFRA, detail: `${INFRA.detail}; the fallback fresh reviewer failed too` } });
  });

  it("ask the owner at once when a round failed on more than infrastructure", async () => {
    const run = d7Run({ failedOutcomes: ["timeout", "external-hold", "timeout"] });

    expect(await demoteFailedRounds(run, HEAD, FAILED)).toEqual({ route: "gate", escalated: FAILED });
    expect(run.fresh.size).toBe(0);
  });

  it("route a seat-held escalation, which no review round failed, to the seat's notice and no fallback reviewer", async () => {
    const run = d7Run();
    const held: Escalated = { ...INFRA, words: SEAT_HELD_ROUNDS_WORDS };

    expect(await demoteFailedRounds(run, HEAD, held)).toEqual({ route: "notice", to: "seat-held", escalated: held });
    expect(await demoteFailedRounds(run, HEAD, held, { ...GATE_DEMOTIONS, failedFallback: false })).toEqual({ route: "gate", escalated: held });
    expect(run.fresh.size).toBe(0);
  });

  it("ask the owner at once with the demotion reverted", async () => {
    const run = d7Run();

    expect(await demoteFailedRounds(run, HEAD, INFRA, { ...GATE_DEMOTIONS, failedRounds: false })).toEqual({ route: "gate", escalated: INFRA });
    expect(run.fresh.size).toBe(0);
  });

  it("mark the escalation infra-only only when every counted round was throttled, timed out or silent", async () => {
    const counts = (outcomes: string[]) => ({
      ...{ ...recordingCtx(), target: { repo: REPO, pr: 1 }, failedRounds: 2, failedOutcomes: outcomes },
      ...{ throttledRounds: 1, closer: { streak: 0 }, seatHeldRounds: new Map(), fixFirstTrail: [] },
    });

    expect(await countRound(counts(["no-verdict", "throttled"]), silentRound)).toMatchObject({ escalation: "failed-rounds", infraOnly: true });
    expect(await countRound(counts(["external-hold", "timeout"]), silentRound)).not.toHaveProperty("infraOnly");
  });
});

/** A context whose seat notice answers `sent` and whose await-new-head sees `NEXT` pushed. */
function noticeCtx(sent: boolean): Recorded {
  return recordingCtx((stepId, input) => {
    if (stepId.startsWith("sh-seat-notice")) return { sent, detail: sent ? "told hub-seat" : "no seat notice is wired" };
    if (stepId.startsWith("await-new-head")) return { headSha: NEXT, state: "open" };
    return { ...input, commentId: 7 };
  });
}

const NEXT = fakeSha("demotion-next");

describe("D7 residual: a failed fallback reviewer goes to ops (TP-3734)", () => {
  it("records D7/ops-notice, tells the hub seat the failed outcomes and the reviewer account, and waits for a new head with its rounds counted afresh", async () => {
    const run = { ...d7Run({ fallbackReviewed: true, failedRounds: 4, failedOutcomes: ["no-verdict", "no-verdict", "no-verdict", "timeout"] }), ...noticeCtx(true) };
    noteReviewerAccount(run, `sh-review-intent:${HEAD}`, { kind: "intent", account: "reviewer-b" });

    const left = await onEscalated(run, HEAD, INFRA).catch((error: unknown) => error);

    expect(left).toBeInstanceOf(LeaveLand);
    expect(left instanceof LeaveLand && left.outcome).toBeUndefined();
    expect(run.steps.map((recorded) => recorded.stepId)).toEqual([`sh-auto-pass:D7-ops-notice:${HEAD}`, "sh-seat-notice", "await-new-head:0"]);
    const notice = run.steps[1]!.input;
    expect(notice).toMatchObject({ gate: "review-infra", headSha: HEAD });
    expect(notice["why"]).toContain("failed rounds: no-verdict, no-verdict, no-verdict, timeout");
    expect(notice["why"]).toContain("reviewer account: reviewer-b");
    expect(run.escalations.size).toBe(0);
    expect(run).toMatchObject({ failedRounds: 0, failedOutcomes: [], fallbackReviewed: false });
  });

  it("tells the seat of a seat-held run-out instead of the owner, under D7/seat-notice", async () => {
    const run = { ...d7Run(), ...noticeCtx(true) };

    await expect(onEscalated(run, HEAD, { ...INFRA, words: SEAT_HELD_ROUNDS_WORDS })).rejects.toBeInstanceOf(LeaveLand);

    expect(run.steps[0]?.stepId).toBe(`sh-auto-pass:D7-seat-notice:${HEAD}`);
    expect(run.steps[1]?.input).toMatchObject({ gate: "seat-held", headSha: HEAD });
  });

  it("asks the owner only when the notice could not go out, naming why", async () => {
    const run = { ...d7Run({ fallbackReviewed: true }), ...noticeCtx(false) };

    expect(await onEscalated(run, HEAD, INFRA)).toBe(true);

    expect(run.escalations.get(HEAD)?.detail).toBe(`${INFRA.detail}; the fallback fresh reviewer failed too (no seat notice is wired)`);
  });
});

interface Sent {
  seat: string;
  text: string;
}

const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

/** A run on a green PR whose every review ends with `cause`, with a seat book and a hub seat that record what they hear. */
function silentReviewWorld(cause: "no-verdict" | "timeout", policy: EffectivePolicy) {
  const fake = fakeGitHub();
  fake.onGetPr = (pr) => fake.setRuns(pr.headSha, GREEN);
  fake.addPr({ headSha: HEAD });
  const sent: Sent[] = [];
  const ports: ExitNoticePorts = { seatFor: () => "repo-seat", hubSeat: () => "hub-seat", lastReport: async () => undefined, send: async (seat, text) => void sent.push({ seat, text }) };
  const reviews: { headSha: string; fresh?: boolean }[] = [];
  const phases: ShepherdPhases = {
    wake: async () => ({ kind: "unhandled", reason: "no fixer in this replay" }),
    review: async (_ctx, request) => (reviews.push({ headSha: request.headSha, ...(request.fresh && { fresh: true }) }), { kind: "none", cause }),
  };
  const store = shepherdStoreRef();
  let clock = 0;
  const routes = factoryRoutesFor({ port: githubPort(fake.wire), store, now: () => clock, sleep: async (ms, signal) => ((clock += ms), sleep(1, signal)), exitNotice: ports, park: async () => ({ lines: [] }) });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [shepherdPrWorkflow(phases)], routes, gatePollMs: 5 });
  hosts.push(host);
  const runId = host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", policy: JSON.stringify(policy) });
  store.get().register({ repo: REPO, pr: 1, runId, task: "demo/1", implementer: "impl-a", policy });
  return { fake, host, runId, sent, reviews };
}

type SilentWorld = ReturnType<typeof silentReviewWorld>;

async function waitingForNewHead({ host, runId }: SilentWorld): Promise<void> {
  await vi.waitFor(() => expect(host.runtime.status(runId)?.currentStep).toMatch(/^await-new-head/));
}

const stepIds = ({ host, runId }: SilentWorld): string[] => Object.keys(host.runtime.status(runId)!.stepResults);

const AUTO: EffectivePolicy = { merge: "auto", mergeMethod: "squash", fixer: true, seat: "repo-seat" };

describe("D7 residual replays: no approve-merge for rounds that never got a verdict (TP-3734)", () => {
  it("tp#1948: three no-verdict rounds and a failed fallback tell the hub seat and wait for a new head, with no owner gate", async () => {
    const world = silentReviewWorld("no-verdict", AUTO);

    await waitingForNewHead(world);

    expect(world.host.gates.listPending()).toEqual([]);
    expect(stepIds(world).filter((id) => id.startsWith("approve-merge"))).toEqual([]);
    expect(stepIds(world).filter((id) => id.startsWith("sh-auto-pass"))).toEqual([`sh-auto-pass:D7-fallback-reviewer:${HEAD}:0`, `sh-auto-pass:D7-ops-notice:${HEAD}:0`]);
    expect(world.reviews).toEqual([{ headSha: HEAD }, { headSha: HEAD, fresh: true }, { headSha: HEAD, fresh: true }, { headSha: HEAD, fresh: true }]);
    expect(world.sent).toHaveLength(1);
    expect(world.sent[0]!.seat).toBe("hub-seat");
    expect(world.sent[0]!.text).toContain("failed rounds: no-verdict, no-verdict, no-verdict, no-verdict");
    expect(world.sent[0]!.text).toContain("reviewer infrastructure defect");
  });

  it("td#808: a visual owner-gate registration's timed-out rounds reach ops too, and the next head's rounds count afresh", async () => {
    const world = silentReviewWorld("timeout", { ...AUTO, merge: "owner-gate", ownerGateReason: "gate-2-visual", visualPaths: ["packages/ui/**"] });
    await waitingForNewHead(world);
    const NEW_HEAD = fakeSha("demotion-pushed");

    world.fake.pushHead(1, NEW_HEAD);

    await vi.waitFor(() => expect(world.sent).toHaveLength(2));
    expect(world.host.gates.listPending()).toEqual([]);
    expect(stepIds(world).filter((id) => id.startsWith("approve-merge"))).toEqual([]);
    expect(world.sent.map((notice) => notice.seat)).toEqual(["hub-seat", "hub-seat"]);
    expect(world.sent[1]!.text).toContain(`at head ${NEW_HEAD}`);
    expect(world.sent[1]!.text).toContain("failed rounds: timeout, timeout, timeout, timeout");
    expect(world.reviews.filter((review) => review.headSha === NEW_HEAD)).toEqual([{ headSha: NEW_HEAD }, ...Array(3).fill({ headSha: NEW_HEAD, fresh: true })]);
  });

  it("opens approve-merge as before with the ops notice reverted", async () => {
    GATE_DEMOTIONS.failedFallback = false;
    hosts.push(partialFake<FactoryHost>({ close: () => void (GATE_DEMOTIONS.failedFallback = true) }));
    const world = silentReviewWorld("no-verdict", AUTO);

    await gateOpened(world.host, gateId(world.runId, "approve-merge"));

    expect(world.host.gates.get(gateId(world.runId, "approve-merge"))?.prompt).toContain("the fallback fresh reviewer failed too");
    expect(world.sent).toEqual([]);
  });
});

describe("D8 is unchanged", () => {
  it.each([
    ["fix-first-runaway", fixFirstEscalation(3, 0, HEAD)],
    ["no-progress", fixFirstEscalation(1, 2, HEAD)],
  ])("a %s escalation still asks the owner, with no fallback reviewer", async (escalation, escalated) => {
    const run = d7Run();

    expect(escalated?.escalation).toBe(escalation);
    expect(await demoteFailedRounds(run, HEAD, escalated!)).toEqual({ route: "gate", escalated });
    expect(run.fresh.size).toBe(0);
  });
});

const MERGED = fakeSha("merged");

describe("D13: a red main with no freeze store", () => {
  const RED_READ = { verdict: "red", mergeSha: MERGED, after: [], detail: "failed: validate" };
  const UNWIRED = { state: "unwired", fixTask: null, fixer: null, episode: null, fixPr: null };
  const CLEANED = { ref: "branch", task: "T-0", retired: [], caveats: [] };
  const BY_STEP: Record<string, object> = { "sh-main-ci": RED_READ, "sh-freeze": UNWIRED, "sh-cleanup": CLEANED };
  const unwired = (stepId: string, input: Record<string, unknown>) => BY_STEP[stepId] ?? { ...input, commentId: 7 };

  it("records an FYI line, naming the rule and the merge, and opens no gate", async () => {
    const { ctx, steps, asked } = recordingCtx(unwired);

    await shepherdMainCi(ctx, { repo: REPO, pr: 1, mergeSha: MERGED }, []);

    expect(asked).toEqual([]);
    const fyi = steps.find((recorded) => recorded.stepId.startsWith("sh-auto-pass"));
    expect(fyi).toMatchObject({ stepId: `sh-auto-pass:D13-main-red-fyi:${MERGED}`, input: { rule: "D13/main-red-fyi", headSha: MERGED } });
    expect(fyi?.input["evidence"]).toEqual([`merge sha: ${MERGED}`, "main CI read: failed: validate. No freeze store is wired.", "run: run-1"]);
  });

  it("still freezes a red main where the store is wired, and records no FYI line", async () => {
    const frozen = { state: "new", fixTask: "T-1", fixer: null, episode: 1, fixPr: null };
    const filed = { task: "T-1", thawed: true, detail: "" };
    const { ctx, steps } = recordingCtx((stepId, input) => (stepId === "sh-freeze" ? frozen : stepId === "sh-file-fix-task" ? filed : unwired(stepId, input)));

    await shepherdMainCi(ctx, { repo: REPO, pr: 1, mergeSha: MERGED }, []);

    expect(steps.map((recorded) => recorded.stepId)).toEqual(["sh-main-ci", "sh-freeze", "sh-file-fix-task", "sh-cleanup"]);
  });

  it("asks the owner to acknowledge with the demotion reverted", async () => {
    const { ctx, asked } = recordingCtx(unwired);

    await shepherdMainCi(ctx, { repo: REPO, pr: 1, mergeSha: MERGED }, [], false, { ...GATE_DEMOTIONS, mainRed: false });

    expect(asked).toEqual(["main-red"]);
  });
});

describe("the demotion config", () => {
  it("demotes D7, its residual, D8, D9 and D13", () => {
    expect(GATE_DEMOTIONS).toEqual({ failedRounds: true, mainRed: true, failedFallback: true, conflict: true, fixFirstRunaway: true });
  });
});

describe("the audit record", () => {
  const record = { rule: "D7/fallback-reviewer" as const, headSha: HEAD, detail: "three rounds failed", evidence: [`head ${HEAD}`] };

  it("reads back from the run's recorded steps for the watch row, skipping other steps", () => {
    const done = (stepId: string, completedAt: string, result: object): StepResult => ({ stepId, iteration: 0, agentId: null, signal: null, completedAt, data: { result } });
    const steps = [done(`sh-auto-pass:D7-fallback-reviewer:${HEAD}`, "2026-10-19T00:00:00Z", { ...record, commentId: 7 }), done("sh-review:0", "2026-10-19T00:01:00Z", {})];

    expect(autoPassesOf(steps)).toEqual([{ rule: "D7/fallback-reviewer", headSha: HEAD, detail: "three rounds failed", at: "2026-10-19T00:00:00Z" }]);
  });

  it("posts a PR comment naming the rule, the head and every evidence line", () => {
    const body = autoPassComment({ repo: REPO, pr: 1, ...record });

    expect(body.split("\n")[0]).toBe(`<!-- shepherd-auto-pass:D7/fallback-reviewer:${HEAD} -->`);
    expect(body).toContain("under rule `D7/fallback-reviewer`");
    expect(body).toContain(`- head ${HEAD}`);
  });
});
