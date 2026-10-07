import { fakeSha } from "@titan-design/github";
import type { GateRecord, GateResolver } from "@titan-design/hitl";
import { describe, expect, it } from "vitest";
import { toJSONSchema, z } from "zod";
import { coordinatorEvidencePolicy, gatePr, landGate, mainGate, mechanicalAuthorityReason, mergeableOf, type CoordinatorEvidence } from "./coordinator-evidence.js";
import { acknowledgeBrief, approveMergeDecision, ciFailedDecision } from "./gate-brief.js";
import { authorityGateReason, pendingCheck } from "./test-support/authority-reason.js";

const HEAD = fakeSha("head");
const MERGE_SHA = fakeSha("merge");
const TIP = fakeSha("tip");
const COORDINATOR: GateResolver = { class: "coordinator", id: "tc-synthetic", channel: "factory-cli" };
const MERGE = { decision: "merge", headSha: HEAD };
const MECHANICAL = authorityGateReason(HEAD, pendingCheck(HEAD));

function gate(fields: Partial<GateRecord> & Pick<GateRecord, "id" | "prompt">): GateRecord {
  return {
    ...{ schema: undefined, status: "pending", payload: undefined, reason: undefined, createdAt: "2026-10-07T00:00:00.000Z", resolvedAt: undefined },
    ...{ expiresAt: undefined, resolvedBy: undefined, resolvedEvidence: undefined, rule: undefined, summary: undefined, evidenceRef: undefined, questions: undefined },
    ...fields,
  };
}

function mergeGate(rule = "authority/MRG-AU", reason = MECHANICAL): GateRecord {
  const { schema, brief } = approveMergeDecision({ repo: "o/r", pr: 1, headSha: HEAD, reason, reviewedMerge: true });
  const prompt = `Merge PR #1 in o/r at head ${HEAD}? CI is green. Policy ${rule}: ${reason}`;
  return gate({ id: "run-1/approve-merge", prompt, schema: toJSONSchema(schema) as Record<string, unknown>, ...brief });
}

const RUN = { workflow: "shepherd-pr", repo: "o/r", pr: 1, rule: "authority/MRG-AU", reason: MECHANICAL, merge: "auto", visualPaths: false, held: false, frozen: false };
const CHECK = (id: number, name: string, conclusion = "success") => ({ id, name, conclusion, headSha: HEAD });

function mergeEvidence(overrides: Partial<Extract<CoordinatorEvidence, { kind: "approve-merge" }>> = {}): CoordinatorEvidence {
  return {
    ...{ kind: "approve-merge", gateId: "run-1/approve-merge", repo: "o/r", pr: 1, headSha: HEAD, run: RUN },
    ...{ verdict: { step: `sh-await-verdict:${HEAD}`, verdict: "MERGE", head: HEAD, reviewer: "rv-synthetic" } },
    ...{ checks: { base: "main", required: ["validate", "dag-check"], runs: [CHECK(11, "validate"), CHECK(12, "dag-check")] } },
    ...{ pull: { state: "open", headSha: HEAD, mergeableState: "clean", mergeable: "MERGEABLE" }, readAt: "2026-10-07T18:00:00.000Z" },
    ...overrides,
  } as CoordinatorEvidence;
}

const admits = (record: GateRecord, payload: unknown, evidence: unknown, resolver = COORDINATOR) => coordinatorEvidencePolicy(record, resolver, payload, evidence as Record<string, unknown>);

describe("coordinatorEvidencePolicy over an approve-merge gate", () => {
  it("admits complete evidence at the gated head", () => {
    expect(admits(mergeGate(), MERGE, mergeEvidence())).toBe(true);
  });

  it.each([
    ["a red required check", { checks: { base: "main", required: ["validate", "dag-check"], runs: [CHECK(11, "validate"), CHECK(12, "dag-check", "failure")] } }],
    ["a required check with no run", { checks: { base: "main", required: ["validate", "dag-check"], runs: [CHECK(11, "validate")] } }],
    ["no required checks at all", { checks: { base: "main", required: [], runs: [] } }],
    ["mergeable unknown", { pull: { state: "open", headSha: HEAD, mergeableState: "unknown", mergeable: "UNKNOWN" } }],
    ["a mergeable claim the raw state does not back", { pull: { state: "open", headSha: HEAD, mergeableState: "dirty", mergeable: "MERGEABLE" } }],
    ["a PR head off the gated head", { pull: { state: "open", headSha: fakeSha("moved"), mergeableState: "clean", mergeable: "MERGEABLE" } }],
    ["a verdict at another head", { verdict: { step: `sh-await-verdict:${HEAD}`, verdict: "MERGE", head: fakeSha("old"), reviewer: "rv" } }],
    ["a FIX_FIRST verdict", { verdict: { step: `sh-await-verdict:${HEAD}`, verdict: "FIX_FIRST", head: HEAD, reviewer: "rv" } }],
    ["evidence for another gate", { gateId: "run-2/approve-merge" }],
    ["a held registration", { run: { ...RUN, held: true } }],
    ["a frozen repo", { run: { ...RUN, frozen: true } }],
    ["a seat owner-gate policy", { run: { ...RUN, merge: "owner-gate" } }],
    ["a recorded rule other than the prompt's", { run: { ...RUN, rule: "authority/MRG-AU-RV" } }],
    ["a recorded reason other than the prompt's", { run: { ...RUN, reason: authorityGateReason(HEAD, { ...pendingCheck(HEAD), changedPaths: ["CODEOWNERS"] }) } }],
  ])("refuses %s", (_case, overrides) => {
    expect(admits(mergeGate(), MERGE, mergeEvidence(overrides as never))).toBe(false);
  });

  it.each(["shepherd-merge-guard/visual-path", "shepherd-seat/synthetic", "shepherd-route/repair-budget", "shepherd-merge-guard/github-path", "shepherd-release/owner-gate"])("refuses a %s gate even with matching evidence", (rule) => {
    expect(admits(mergeGate(rule), MERGE, mergeEvidence({ run: { ...RUN, rule } }))).toBe(false);
  });

  it("refuses a payload whose head differs from the gate's, or that carries extra fields", () => {
    expect(admits(mergeGate(), { decision: "merge", headSha: fakeSha("other") }, mergeEvidence())).toBe(false);
    expect(admits(mergeGate(), { ...MERGE, note: "x" }, mergeEvidence())).toBe(false);
  });

  it("refuses every class but coordinator, and evidence with unknown fields", () => {
    expect(admits(mergeGate(), MERGE, mergeEvidence(), { ...COORDINATOR, class: "automation" })).toBe(false);
    expect(admits(mergeGate(), MERGE, { ...mergeEvidence(), extra: true })).toBe(false);
  });

  it("refuses a gate whose prompt head and schema head disagree", () => {
    const record = { ...mergeGate(), prompt: mergeGate().prompt.replace(HEAD, fakeSha("other")) };

    expect(landGate(record)).toBeUndefined();
    expect(admits(record, MERGE, mergeEvidence())).toBe(false);
  });
});

describe("coordinatorEvidencePolicy over main-red and PR gates", () => {
  const ackSchema = toJSONSchema(z.object({ decision: z.literal("acknowledged"), mergeSha: z.string() })) as Record<string, unknown>;
  const mainRed = gate({ id: "run-1/main-red", prompt: `Main CI on o/r at merge ${MERGE_SHA} (PR #1) is red: failed. Acknowledge.`, schema: ackSchema, ...acknowledgeBrief({ repo: "o/r", mergeSha: MERGE_SHA, headline: "red", detail: "failed" }) });
  const green = { kind: "main-green", gateId: "run-1/main-red", repo: "o/r", pr: 1, mergeSha: MERGE_SHA, base: "main", greenSha: TIP, mergeBaseSha: MERGE_SHA, runs: [{ id: 21, name: "validate", conclusion: "success", headSha: TIP }], readAt: "x" };
  const ack = { decision: "acknowledged", mergeSha: MERGE_SHA };

  it("admits an acknowledgement once a green commit contains the merge, and nothing else", () => {
    expect(mainGate(mainRed)).toEqual({ repo: "o/r", mergeSha: MERGE_SHA, pr: 1 });
    expect(admits(mainRed, ack, green)).toBe(true);
    expect(admits(mainRed, ack, { ...green, mergeBaseSha: fakeSha("elsewhere") })).toBe(false);
    expect(admits(mainRed, ack, { ...green, runs: [] })).toBe(false);
    expect(admits(mainRed, ack, { ...green, runs: [{ ...green.runs[0], conclusion: "failure" }] })).toBe(false);
    expect(admits(mainRed, { ...ack, mergeSha: TIP }, green)).toBe(false);
    expect(admits({ ...mainRed, schema: undefined }, ack, green)).toBe(false);
  });

  it("admits an abandon of a merged PR's red-CI gate only with the head its schema pins, never one still open", () => {
    const failing = [{ name: "validate", url: "https://example.test/job/1" }] as never;
    const { schema, brief } = ciFailedDecision({ repo: "o/r", pr: 1, headSha: HEAD, failing });
    const ciFailed = gate({ id: "run-1/ci-failed:2", prompt: "red", schema: toJSONSchema(schema) as Record<string, unknown>, ...brief });
    const gone = { kind: "pr-gone", gateId: "run-1/ci-failed:2", repo: "o/r", pr: 1, state: "merged", readAt: "x" };
    const abandon = { decision: "abandon", headSha: HEAD };

    expect(gatePr(ciFailed)).toEqual({ repo: "o/r", pr: 1 });
    expect(admits(ciFailed, abandon, gone)).toBe(true);
    expect(admits(ciFailed, { decision: "abandon" }, gone)).toBe(false);
    expect(admits(ciFailed, { ...abandon, headSha: fakeSha("other") }, gone)).toBe(false);
    expect(admits(ciFailed, abandon, { ...gone, state: "open" })).toBe(false);
    expect(admits(ciFailed, abandon, { ...gone, pr: 2 })).toBe(false);
    expect(admits(ciFailed, { ...abandon, decision: "rerun" }, gone)).toBe(false);
    expect(admits({ ...ciFailed, schema: undefined }, abandon, gone)).toBe(false);
  });
});

describe("mechanicalAuthorityReason", () => {
  it("reads a gate on a reviewer verdict, required checks or the merge tree alone as mechanical", () => {
    expect(mechanicalAuthorityReason(MECHANICAL)).toBe(true);
    expect(mechanicalAuthorityReason(authorityGateReason(HEAD, { verdict: { value: "FIX_FIRST", head: HEAD }, mergeTreeClean: false }))).toBe(true);
  });

  it.each([
    ["CODEOWNERS", { changedPaths: ["CODEOWNERS"] }],
    ["docs/CODEOWNERS", { changedPaths: ["docs/CODEOWNERS"] }],
    [".gitmodules", { changedPaths: [".gitmodules"] }],
    [".github/CODEOWNERS", { changedPaths: [".github/CODEOWNERS"] }],
    ["a non-canonical path", { changedPaths: ["src/./a.ts"] }],
    ["a missing seat grant", { seatGrants: [] }],
    ["a frozen repo", { repoFrozen: true }],
    ["another dispatched reviewer", { dispatchedReviewer: { agentId: "rv-other", sessionId: "s" } }],
  ])("refuses a gate that also names %s", (_case, overrides) => {
    expect(mechanicalAuthorityReason(authorityGateReason(HEAD, { ...pendingCheck(HEAD), ...overrides }))).toBe(false);
  });

  it("refuses a tainted request, facts read closed, a bare authority reason and anything unrecognised", () => {
    expect(mechanicalAuthorityReason(authorityGateReason(HEAD, {}, true))).toBe(false);
    expect(mechanicalAuthorityReason(`${MECHANICAL}; read closed: mergeable_state`)).toBe(false);
    expect(mechanicalAuthorityReason(MECHANICAL.slice(MECHANICAL.indexOf("MRG-AU gates")))).toBe(false);
    expect(mechanicalAuthorityReason("the authority policy did not allow an automated merge: MRG-AU gates merge by automation; MRG-AU-RV unmet: some-new-condition")).toBe(false);
  });
});

describe("mergeableOf", () => {
  it("reads only settled, conflict-free states as MERGEABLE", () => {
    expect(["clean", "blocked", "unstable", "has_hooks"].map(mergeableOf)).toEqual(["MERGEABLE", "MERGEABLE", "MERGEABLE", "MERGEABLE"]);
    expect(["dirty", "unknown", "behind", "draft", ""].map(mergeableOf)).toEqual(["CONFLICTING", "UNKNOWN", "UNKNOWN", "UNKNOWN", "UNKNOWN"]);
  });
});
