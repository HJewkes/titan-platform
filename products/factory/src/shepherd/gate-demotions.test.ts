import { fakeGitHub, fakeSha, githubPort, successRun, type CheckRun, type PrFile } from "@titan-design/github";
import type { SourceTextLocator } from "@titan-design/session-read";
import { partialFake } from "@titan-design/test-kit";
import type { DispatchOptions, StepResult, WorkflowContext } from "@titan-design/workflow";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { GATE_DEMOTIONS, VISUAL_DEMOTION, VISUAL_DEMOTION_NOTE, autoPassComment, autoPassesOf } from "./auto-pass.js";
import { demoteFailedRounds, type FailedRoundsRun } from "./failed-rounds-demotion.js";
import { decideAutoMerge, mergeEvidence, noFreezeStoreUntilTp523, type MergeEvidence, type MergeEvidenceInput } from "./merge-facts.js";
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
const GREEN: CheckRun[] = [successRun("validate", 1), successRun("dag-check", 6), successRun("visual", 2), successRun("contrast 1/3", 3), successRun("contrast 2/3", 4), successRun("contrast 3/3", 5)];
const red = (name: string, id: number): CheckRun => successRun(name, id, undefined, "failure");

async function evidenceFor(files: PrFile[], runs: CheckRun[] = GREEN, over: Partial<MergeEvidenceInput> = {}): Promise<MergeEvidence> {
  const fake = fakeGitHub();
  fake.addPr({ headSha: HEAD, mergeSha: fakeSha("test-merge") });
  fake.setRuns(HEAD, runs);
  fake.prFiles.set(1, files);
  return mergeEvidence(githubPort(fake.wire), { ...input, ...over }, noFreezeStoreUntilTp523, { kind: "feature" });
}

describe("D2: a visual-path head merges without the owner only on the guard", () => {
  it("allows a story-only change with every visual and contrast check green and a MERGE at the head, and says so in the reason", async () => {
    const evidence = await evidenceFor(STORY);

    const decision = decideAutoMerge(HEAD, evidence, VISUAL_PATHS);

    expect(decision.outcome).toBe("allow");
    expect(decision.reason).toContain(VISUAL_DEMOTION_NOTE);
    expect(decision.reason).toContain(`green at the head: visual, contrast 1/3, contrast 2/3, contrast 3/3`);
    expect(decision.reason).toContain(`MERGE at ${HEAD} by agent-rv-1/session-rv-1`);
    expect(evidence.record.decision.reason).toContain(VISUAL_DEMOTION_NOTE);
  });

  it.each([
    ["a snapshot PNG", "packages/ui/tests/visual/reference/button-chromium-linux.png"],
    ["a contrast baseline entry", "packages/ui/tests/visual/contrast-stories-baseline.json"],
    ["a design token", "packages/ui/src/theme/tokens/colors.ts"],
  ])("keeps the visual-path gate for a head that changes %s", async (_case, path) => {
    const evidence = await evidenceFor([...STORY, { path, status: "modified" }]);

    const decision = decideAutoMerge(HEAD, evidence, VISUAL_PATHS);

    expect(decision).toMatchObject({ outcome: "gate", rule: { table: "shepherd-merge-guard", rowId: "visual-path" } });
  });

  it.each([
    ["the visual job failed", [...GREEN.filter((run) => run.name !== "visual"), red("visual", 9)]],
    ["the visual job never ran", GREEN.filter((run) => run.name !== "visual")],
    ["a contrast shard failed", [...GREEN.filter((run) => run.name !== "contrast 2/3"), red("contrast 2/3", 9)]],
    ["a contrast shard is missing", GREEN.filter((run) => run.name !== "contrast 3/3")],
  ])("keeps the visual-path gate when %s", async (_case, runs) => {
    const evidence = await evidenceFor(STORY, runs);

    expect(decideAutoMerge(HEAD, evidence, VISUAL_PATHS)).toMatchObject({ outcome: "gate", rule: { rowId: "visual-path" } });
  });

  it("keeps the visual-path gate when the MERGE was written at another head", async () => {
    const evidence = await evidenceFor(STORY, GREEN, { verdict: { value: "MERGE", head: fakeSha("older-head"), locator } });

    expect(decideAutoMerge(HEAD, evidence, VISUAL_PATHS)).toMatchObject({ outcome: "gate", rule: { rowId: "visual-path" } });
  });

  it("keeps files-unread for the owner even when every other condition holds", async () => {
    const evidence = { ...(await evidenceFor(STORY)), changedFilesUnread: "the PR's files could not be read" };

    expect(decideAutoMerge(HEAD, evidence, VISUAL_PATHS)).toMatchObject({ outcome: "gate", rule: { rowId: "files-unread" } });
  });

  it("keeps the visual-path gate with the demotion reverted", async () => {
    const evidence = await evidenceFor(STORY);

    expect(decideAutoMerge(HEAD, evidence, VISUAL_PATHS, undefined, null)).toMatchObject({ outcome: "gate", rule: { rowId: "visual-path" } });
  });
});

const GATE2: EffectivePolicy = { merge: "owner-gate", ownerGateReason: "gate-2-visual", mergeMethod: "squash", fixer: true, seat: "design-seat", visualPaths: VISUAL_PATHS };
const mergeAt = (evidence: MergeEvidence): ((headSha: string) => Verdict) => () => ({ kind: "MERGE", headSha: HEAD, evidence });

describe("D2: a gate-2-visual registration", () => {
  it("merges without the owner when the guard holds at the head, naming the registration in the reason", async () => {
    const evidence = await evidenceFor([{ path: "packages/ui/src/Button.test.tsx", status: "modified" }]);

    const decision = shepherdGatePolicy(GATE2, mergeAt(evidence)).decide("merge", { headSha: HEAD });

    expect(decision.outcome).toBe("allow");
    expect(decision.reason).toContain(VISUAL_DEMOTION_NOTE);
    expect(decision.reason).toContain("gate-2-visual registration of seat design-seat");
  });

  it("waits for the owner when the head refreshes a baseline PNG", async () => {
    const evidence = await evidenceFor([...STORY, { path: "packages/ui/specimen/baseline/a-chromium-linux.png", status: "modified" }]);

    expect(shepherdGatePolicy(GATE2, mergeAt(evidence)).decide("merge", { headSha: HEAD }).outcome).toBe("gate");
  });

  it("waits for the owner when a contrast shard is red", async () => {
    const evidence = await evidenceFor(STORY, [...GREEN.filter((run) => run.name !== "contrast 1/3"), red("contrast 1/3", 9)]);

    expect(shepherdGatePolicy(GATE2, mergeAt(evidence)).decide("merge", { headSha: HEAD }).outcome).toBe("gate");
  });

  it("waits for the owner on a seat with no visual paths, whose ceiling is the owner gate", async () => {
    const evidence = await evidenceFor(STORY);
    const noVisual: EffectivePolicy = { merge: "owner-gate", ownerGateReason: "gate-2-visual", mergeMethod: "squash", fixer: true, seat: "design-seat" };

    expect(shepherdGatePolicy(noVisual, mergeAt(evidence)).decide("merge", { headSha: HEAD }).outcome).toBe("gate");
  });

  it("waits for the owner with the demotion reverted", async () => {
    const evidence = await evidenceFor(STORY);

    expect(shepherdGatePolicy(GATE2, mergeAt(evidence), null).decide("merge", { headSha: HEAD }).outcome).toBe("gate");
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

async function d7Run(over: Partial<FailedRoundsRun> = {}): Promise<FailedRoundsRun & Recorded> {
  const recorded = recordingCtx();
  const evidence = await evidenceFor([{ path: "src/x.ts", status: "modified" }]);
  const merge: Verdict = { kind: "MERGE", headSha: HEAD, evidence };
  return {
    ...recorded,
    ...{ target: { repo: REPO, pr: 1 }, reviews: new Map(), merged: new Map([[HEAD, merge]]), fresh: new Set<string>(), escalations: new Map(), failedRounds: 3 },
    ...{ lastCi: { verdict: "green", headSha: HEAD, mergeableState: "clean", contexts: ["validate"] }, failedOutcomes: ["timeout", "no-verdict", "throttled"], fallbackReviewed: false },
    ...over,
  };
}

describe("D7: failed review rounds", () => {
  it("go on to the merge decision on the standing MERGE when only infrastructure failed and CI is green, recording the rule and evidence", async () => {
    const run = await d7Run();

    const routed = await demoteFailedRounds(run, HEAD, INFRA);

    expect(routed).toEqual({ route: "merge" });
    expect(run.reviews.get(HEAD)?.kind).toBe("MERGE");
    expect(run.steps).toHaveLength(1);
    expect(run.steps[0]).toMatchObject({ stepId: `sh-auto-pass:D7-infra-standing-merge:${HEAD}`, input: { rule: "D7/infra-standing-merge", headSha: HEAD } });
    expect(run.steps[0]?.input["evidence"]).toEqual([`head ${HEAD}`, "failed rounds: timeout, no-verdict, throttled", `MERGE standing at ${HEAD}`, `CI green at ${HEAD}: validate`]);
  });

  it("dispatch a fresh reviewer, not the owner, when a round failed on more than infrastructure", async () => {
    const run = await d7Run({ failedOutcomes: ["timeout", "external-hold", "timeout"] });

    const routed = await demoteFailedRounds(run, HEAD, FAILED);

    expect(routed).toEqual({ route: "review-again" });
    expect(run.fresh.has(HEAD)).toBe(true);
    expect(run.fallbackReviewed).toBe(true);
    expect(run.steps[0]).toMatchObject({ input: { rule: "D7/fallback-reviewer" } });
  });

  it("dispatch a fresh reviewer when only infrastructure failed but CI is not green at the head", async () => {
    const run = await d7Run({ lastCi: { verdict: "pending", headSha: HEAD, mergeableState: "clean" } });

    expect(await demoteFailedRounds(run, HEAD, INFRA)).toEqual({ route: "review-again" });
    expect(run.fresh.has(HEAD)).toBe(true);
  });

  it("dispatch a fresh reviewer when only infrastructure failed but no MERGE stands at the head", async () => {
    const run = await d7Run({ merged: new Map() });

    expect(await demoteFailedRounds(run, HEAD, INFRA)).toEqual({ route: "review-again" });
  });

  it("ask the owner once the fallback reviewer has failed too, saying so", async () => {
    const run = await d7Run({ fallbackReviewed: true, merged: new Map() });

    const routed = await demoteFailedRounds(run, HEAD, INFRA);

    expect(routed).toEqual({ route: "gate", escalated: { ...INFRA, detail: `${INFRA.detail}; the fallback fresh reviewer failed too` } });
    expect(run.steps).toEqual([]);
  });

  it("ask the owner at once for a seat-held escalation, which no review round failed", async () => {
    const run = await d7Run();
    const held: Escalated = { ...INFRA, words: "the seat held Shepherd's own MERGE for 6 rounds at one head" };

    expect(await demoteFailedRounds(run, HEAD, held)).toEqual({ route: "gate", escalated: held });
  });

  it("ask the owner at once with the demotion reverted", async () => {
    const run = await d7Run();

    expect(await demoteFailedRounds(run, HEAD, INFRA, { ...GATE_DEMOTIONS, failedRounds: false })).toEqual({ route: "gate", escalated: INFRA });
  });

  it("mark the escalation infra-only only when every counted round was throttled, timed out or silent", async () => {
    const counts = (outcomes: string[]) => ({
      ...{ ...recordingCtx(), target: { repo: REPO, pr: 1 }, failedRounds: 2, failedOutcomes: outcomes },
      ...{ throttledRounds: 1, closer: { streak: 0 }, seatHeldRounds: new Map(), fixFirstTrail: [] },
    });
    const routed: Routed = { headSha: HEAD, verdict: { kind: "none" }, observed: partialFake<ObservedPr>(), outcome: "timeout", route: "fresh-reviewer" };

    expect(await countRound(counts(["no-verdict", "throttled"]), routed)).toMatchObject({ escalation: "failed-rounds", infraOnly: true });
    expect(await countRound(counts(["external-hold", "timeout"]), routed)).not.toHaveProperty("infraOnly");
  });
});

describe("D8 is unchanged", () => {
  it.each([
    ["fix-first-runaway", fixFirstEscalation(3, 0, HEAD)],
    ["no-progress", fixFirstEscalation(1, 2, HEAD)],
  ])("a %s escalation still asks the owner, with no fallback reviewer", async (escalation, escalated) => {
    const run = await d7Run();

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
  it("names the visual and contrast checks and the baseline globs the D2 guard reads", () => {
    expect(VISUAL_DEMOTION).toMatchObject({ checks: ["visual"], shardedChecks: ["contrast"] });
    expect(GATE_DEMOTIONS).toEqual({ visual: true, failedRounds: true, mainRed: true });
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
