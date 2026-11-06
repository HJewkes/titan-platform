import { fakeSha } from "@titan-design/github";
import type { GateRecord, GateResolver } from "@titan-design/hitl";
import { describe, expect, it } from "vitest";
import { toJSONSchema } from "zod";
import { coordinatorEvidencePolicy } from "./coordinator-evidence.js";
import { approveMergeDecision } from "./gate-brief.js";
import { MERGE_UP_APPROVAL, type MergeUpCommit } from "./merge-up-approval.js";

const APPROVED = fakeSha("approved");
const UP1 = fakeSha("up1");
const HEAD = fakeSha("head");
const MAIN1 = fakeSha("main1");
const MAIN2 = fakeSha("main2");
const COORDINATOR: GateResolver = { class: "coordinator", id: "tc-synthetic", channel: "factory-cli" };
const MERGE = { decision: "merge", headSha: HEAD };
const REASON = "the authority policy did not allow an automated merge: CI-policy weakened: other";

function landGateAt(head: string, id = "run-1/approve-merge:1"): GateRecord {
  const { schema, brief } = approveMergeDecision({ repo: "o/r", pr: 1, headSha: head, reason: REASON, reviewedMerge: true });
  const prompt = `Merge PR #1 in o/r at head ${head} into main? CI is green. Policy shepherd-merge-guard/ci-policy-weakened: ${REASON}`;
  return {
    ...{ id, prompt, schema: toJSONSchema(schema), status: "pending", payload: undefined, reason: undefined, createdAt: "2026-11-06T00:00:00.000Z" },
    ...{ resolvedAt: undefined, expiresAt: undefined, resolvedBy: undefined, resolvedEvidence: undefined, rule: undefined, questions: undefined, ...brief },
  };
}

const mergeUp = (sha: string, firstParent: string, secondParent: string, tree = fakeSha(`tree-${sha}`)): MergeUpCommit => ({ sha, firstParent, secondParent, secondParentOnBase: true, tree, mergeTree: fakeSha(`tree-${sha}`) });

function evidence(overrides: object = {}): Record<string, unknown> {
  return {
    ...{ kind: "merge-up-approval", gateId: "run-1/approve-merge:1", repo: "o/r", pr: 1, headSha: HEAD, base: "main" },
    approval: { gateId: "run-1/approve-merge", head: APPROVED, resolverClass: "owner-terminal" },
    mergeUps: [mergeUp(UP1, APPROVED, MAIN1), mergeUp(HEAD, UP1, MAIN2)],
    checks: { base: "main", required: ["validate"], runs: [{ id: 1, name: "validate", conclusion: "success", headSha: HEAD }] },
    pull: { state: "open", headSha: HEAD, baseRef: "main" },
    readAt: "2026-11-06T21:00:00.000Z",
    ...overrides,
  };
}

const admits = (payload: unknown, raw: Record<string, unknown>, resolver = COORDINATOR, gate = landGateAt(HEAD)) => coordinatorEvidencePolicy(gate, resolver, payload, raw);

describe("a coordinator merge on an owner approval carried by clean merge-ups (decision 556(3))", () => {
  it("admits a merge at the gated head when every commit since the owner's head is a clean merge-up", () => {
    expect(admits(MERGE, evidence())).toBe(true);
  });

  it.each(["owner-remote", "automation", "delegate", "decider"])("admits only a coordinator, never a %s resolver", (cls) => {
    const resolver = { ...COORDINATOR, class: cls } as GateResolver;
    expect(admits(MERGE, evidence(), resolver)).toBe(false);
  });

  it.each([
    ["a merge-up whose tree is not the clean merge-tree of its parents", { mergeUps: [mergeUp(UP1, APPROVED, MAIN1), mergeUp(HEAD, UP1, MAIN2, fakeSha("extra"))] }],
    ["a chain that skips a commit on the PR branch", { mergeUps: [mergeUp(UP1, APPROVED, MAIN1), mergeUp(HEAD, fakeSha("other"), MAIN2)] }],
    ["a chain that starts off the approved head", { mergeUps: [mergeUp(UP1, fakeSha("other"), MAIN1), mergeUp(HEAD, UP1, MAIN2)] }],
    ["a chain that stops short of the gated head", { mergeUps: [mergeUp(UP1, APPROVED, MAIN1)] }],
    ["no merge-ups at all", { mergeUps: [] }],
    ["a second parent not read on the base", { mergeUps: [{ ...mergeUp(HEAD, APPROVED, MAIN1), secondParentOnBase: false }] }],
    ["a chain longer than the rule allows", { mergeUps: longChain(MERGE_UP_APPROVAL.maxMergeUps + 1) }],
    ["an approval a coordinator gave", { approval: { gateId: "run-1/approve-merge", head: APPROVED, resolverClass: "coordinator" } }],
    ["an approval on another run's gate", { approval: { gateId: "run-2/approve-merge", head: APPROVED, resolverClass: "owner-terminal" } }],
    ["an approval that is this gate itself", { approval: { gateId: "run-1/approve-merge:1", head: APPROVED, resolverClass: "owner-terminal" } }],
    ["a red required check at the head", { checks: { base: "main", required: ["validate"], runs: [{ id: 1, name: "validate", conclusion: "failure", headSha: HEAD }] } }],
    ["a PR that moved again", { pull: { state: "open", headSha: fakeSha("moved"), baseRef: "main" } }],
    ["a base the gate does not name", { base: "release", pull: { state: "open", headSha: HEAD, baseRef: "release" } }],
    ["evidence for another gate", { gateId: "run-1/approve-merge:2" }],
  ])("refuses %s", (_case, overrides) => {
    expect(admits(MERGE, evidence(overrides))).toBe(false);
  });

  it("refuses any answer but merge at the gated head", () => {
    expect(admits({ decision: "merge", headSha: APPROVED }, evidence())).toBe(false);
    expect(admits({ decision: "abandon", headSha: HEAD }, evidence())).toBe(false);
  });
});

/** `count` clean merge-ups from the approved head, the last at the gated head. */
function longChain(count: number): MergeUpCommit[] {
  const shas = Array.from({ length: count }, (_, index) => (index === count - 1 ? HEAD : fakeSha(`up-${index}`)));
  return shas.map((sha, index) => mergeUp(sha, index === 0 ? APPROVED : shas[index - 1]!, fakeSha(`main-${index}`)));
}
