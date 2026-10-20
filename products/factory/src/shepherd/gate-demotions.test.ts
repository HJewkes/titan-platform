import { fakeGitHub, fakeSha, githubPort, successRun, type CheckRun, type PrFile } from "@titan-design/github";
import type { SourceTextLocator } from "@titan-design/session-read";
import { partialFake } from "@titan-design/test-kit";
import type { DispatchOptions, StepResult, WorkflowContext } from "@titan-design/workflow";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { GATE_DEMOTIONS, autoPassComment, autoPassesOf } from "./auto-pass.js";
import { demoteFailedRounds, onEscalated, type FailedRoundsRun } from "./failed-rounds-demotion.js";
import { mergeEvidence, noFreezeStoreUntilTp523, type MergeEvidence, type MergeEvidenceInput } from "./merge-facts.js";
import { shepherdGatePolicy, type EffectivePolicy } from "./policy.js";
import { shepherdMainCi } from "./post-merge.js";
import { fixFirstEscalation, type Escalated } from "./route-table.js";
import type { ObservedPr } from "./observe.js";
import { countRound, type Routed } from "./routed.js";
import type { Verdict } from "./phases.js";

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
    ...{ target: { repo: REPO, pr: 1 }, reviews: new Map(), fresh: new Set<string>(), escalations: new Map(), failedRounds: 3 },
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

  it("ask the owner once the fallback reviewer has failed too, saying so", async () => {
    const run = d7Run({ fallbackReviewed: true });

    const routed = await demoteFailedRounds(run, HEAD, INFRA);

    expect(routed).toEqual({ route: "gate", escalated: { ...INFRA, detail: `${INFRA.detail}; the fallback fresh reviewer failed too` } });
    expect(run.steps).toEqual([]);
  });

  it("ask the owner at once when a round failed on more than infrastructure", async () => {
    const run = d7Run({ failedOutcomes: ["timeout", "external-hold", "timeout"] });

    expect(await demoteFailedRounds(run, HEAD, FAILED)).toEqual({ route: "gate", escalated: FAILED });
    expect(run.fresh.size).toBe(0);
  });

  it("ask the owner at once for a seat-held escalation, which no review round failed", async () => {
    const run = d7Run();
    const held: Escalated = { ...INFRA, words: "the seat held Shepherd's own MERGE for 6 rounds at one head" };

    expect(await demoteFailedRounds(run, HEAD, held)).toEqual({ route: "gate", escalated: held });
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
  it("demotes D7, D8 and D13 only", () => {
    expect(GATE_DEMOTIONS).toEqual({ failedRounds: true, mainRed: true, fixFirstRunaway: true });
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
