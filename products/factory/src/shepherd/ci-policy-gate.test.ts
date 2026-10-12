import { fakeGitHub, fakeSha, githubPort, successRun, type PrFile } from "@titan-design/github";
import type { CiPolicy, SourceTextLocator } from "@titan-design/session-read";
import { partialFake } from "@titan-design/test-kit";
import type { DispatchOptions, StepResult, WorkflowContext } from "@titan-design/workflow";
import { describe, expect, it } from "vitest";
import { decisionClassOf } from "../decision-class.js";
import { evidenceComment } from "./evidence-comment.js";
import { MERGE_EVIDENCE_STEP, decideAutoMerge, mergeEvidence, noFreezeStoreUntilTp523, type MergeEvidence, type MergeEvidenceInput } from "./merge-facts.js";
import { refreshMergeEvidence } from "./merge-settle.js";
import type { Verdict } from "./phases.js";
import { shepherdGatePolicy, type EffectivePolicy } from "./policy.js";
import { verdictOf } from "./take-verdict.js";

const REPO = "octo/demo";
const HEAD = fakeSha("ci-policy-head");
const REVIEWER = { agentId: "agent-rv-1", sessionId: "session-rv-1" };
const AUTO: EffectivePolicy = { merge: "auto", mergeMethod: "squash", fixer: true, seat: "trusted-seat" };
const locator = partialFake<SourceTextLocator>({ selector: { kind: "subrecord-text", path: ["message", "content", 0, "text"] } });
const CI_YML = ".github/workflows/ci.yml";
const UNCHANGED: CiPolicy = { kind: "unchanged" };

const input: MergeEvidenceInput = {
  runId: "run-1",
  repo: REPO,
  pr: 1,
  head: HEAD,
  verdict: { value: "MERGE", head: HEAD, locator },
  resolver: REVIEWER,
  dispatchedReviewer: REVIEWER,
  seatGrants: ["merge-on-green-approve"],
};

/** A reviewed MERGE at HEAD with green required checks and a clean test merge; only the files and the line vary. */
async function evidenceFor(files: PrFile[], ciPolicy?: CiPolicy) {
  const fake = fakeGitHub();
  fake.addPr({ headSha: HEAD, mergeSha: fakeSha("test-merge") });
  fake.setRuns(HEAD, [successRun("validate", 1), successRun("dag-check", 2)]);
  fake.prFiles.set(1, files);
  return mergeEvidence(githubPort(fake.wire), { ...input, ...(ciPolicy && { ciPolicy }) }, noFreezeStoreUntilTp523, { kind: "correctness" });
}

const modified = (path: string): PrFile[] => [{ path, status: "modified" }];
const guard = (rowId: string) => ({ table: "shepherd-merge-guard", rowId, version: 1 });

describe("the CI-policy merge guard", () => {
  it("lets a .github/ change whose reviewer wrote 'unchanged' reach authority, which allows", async () => {
    const evidence = await evidenceFor(modified(CI_YML), UNCHANGED);

    expect(evidence.record.decision).toMatchObject({ outcome: "allow", rule: { table: "authority", rowId: "MRG-AU-RV" } });
  });

  it("gates github-path, failing closed, on a .github/ change with no CI-policy line", async () => {
    const evidence = await evidenceFor(modified(CI_YML));

    expect(evidence.record.decision).toEqual({ outcome: "gate", rule: guard("github-path"), reason: `a .github/ change needs the reviewer's CI-policy line: ${CI_YML}` });
  });

  it("allows a change outside .github/ with no CI-policy line", async () => {
    const evidence = await evidenceFor(modified("src/x.ts"));

    expect(evidence.record.decision).toMatchObject({ outcome: "allow", rule: { table: "authority" } });
  });

  it("gates ci-policy-weakened on a weakened line whatever the paths, naming the keys", async () => {
    const evidence = await evidenceFor(modified("src/x.ts"), { kind: "weakened", keys: ["permissions"] });

    expect(evidence.record.decision).toEqual({ outcome: "gate", rule: guard("ci-policy-weakened"), reason: "CI-policy weakened: permissions" });
  });

  it("gates ci-policy-weakened, not github-path, on a weakened .github/ change", async () => {
    const evidence = await evidenceFor(modified(CI_YML), { kind: "weakened", keys: ["secrets", "ruleset"] });

    expect(evidence.record.decision).toMatchObject({ rule: guard("ci-policy-weakened"), reason: "CI-policy weakened: secrets, ruleset" });
  });

  it.each([
    ["a rename out of .github/", [{ path: "tools/x.yml", previousPath: ".github/actions/x.yml", status: "renamed" }] as PrFile[]],
    ["a .GitHub/ path a case-insensitive checkout folds", modified(".GitHub/workflows/x.yml")],
  ])("gates github-path on %s with no line", async (_case, files) => {
    const evidence = await evidenceFor(files);

    expect(evidence.record.decision.rule).toEqual(guard("github-path"));
  });

  it("records the line in the evidence, its record and the PR comment", async () => {
    const evidence = await evidenceFor(modified(CI_YML), { kind: "weakened", keys: ["permissions"] });

    expect(evidence.ciPolicy).toEqual({ kind: "weakened", keys: ["permissions"] });
    expect(evidence.record.ciPolicy).toEqual({ kind: "weakened", keys: ["permissions"] });
    expect(evidenceComment(evidence.record)).toContain("the reviewer says the change weakens CI policy");
  });

  it("files github-path under D6 and ci-policy-weakened under D21", () => {
    const at = (rowId: string) => decisionClassOf({ table: "shepherd-merge-guard", rowId, step: "approve-merge", prompt: "" });

    expect([at("github-path"), at("ci-policy-weakened")]).toEqual(["D6", "D21"]);
  });
});

describe("the tp#1001 fixture: a diff deleting the egress-scan job from ci.yml", () => {
  const deletesEgressScan: PrFile[] = [{ path: CI_YML, status: "modified" }];

  it("gates when the reviewer writes 'weakened required-check'", async () => {
    const evidence = await evidenceFor(deletesEgressScan, { kind: "weakened", keys: ["required-check"] });

    expect(evidence.record.decision).toMatchObject({ outcome: "gate", rule: guard("ci-policy-weakened"), reason: "CI-policy weakened: required-check" });
  });

  it("gates when the reviewer writes no line", async () => {
    const evidence = await evidenceFor(deletesEgressScan);

    expect(evidence.record.decision).toMatchObject({ outcome: "gate", rule: guard("github-path") });
  });
});

describe("a decision replayed on stored evidence", () => {
  const stored = async (ciPolicy?: CiPolicy): Promise<Verdict> => ({ kind: "MERGE", headSha: HEAD, evidence: await evidenceFor(modified(CI_YML), ciPolicy) });
  const withoutLine = ({ ciPolicy: _dropped, ...rest }: MergeEvidence): MergeEvidence => rest;

  it("gates github-path when the stored evidence predates the line", async () => {
    const old: Verdict = { kind: "MERGE", headSha: HEAD, evidence: withoutLine(await evidenceFor(modified(CI_YML), UNCHANGED)) };

    const decision = shepherdGatePolicy(AUTO, () => old).decide("merge", { headSha: HEAD });

    expect(decision.rule).toEqual(guard("github-path"));
  });

  it("allows when the stored evidence carries 'unchanged'", async () => {
    const verdict = await stored(UNCHANGED);

    expect(shepherdGatePolicy(AUTO, () => verdict).decide("merge", { headSha: HEAD }).outcome).toBe("allow");
  });

  it("decides on the line, not the decision recorded with it", async () => {
    const evidence = await evidenceFor(modified(CI_YML), UNCHANGED);

    expect(decideAutoMerge(HEAD, { ...evidence, ciPolicy: { kind: "weakened", keys: ["other"] } }).rule).toEqual(guard("ci-policy-weakened"));
  });
});

interface Asked {
  stepId: string;
  input: Record<string, unknown>;
}

/** A context whose evidence step answers with `evidence` and whose other steps answer unpublished; each step's input is recorded. */
function recordingCtx(asked: Asked[], evidence: object): WorkflowContext {
  async function dispatch<T extends Record<string, unknown>>(stepId: string, _template: string, options: DispatchOptions<T> = {}): Promise<StepResult<T>> {
    const stepInput = JSON.parse(Object.values(options.vars ?? {})[0] ?? "{}") as Record<string, unknown>;
    asked.push({ stepId, input: stepInput });
    const result = stepId.startsWith(MERGE_EVIDENCE_STEP) ? evidence : { published: false };
    return { stepId, iteration: 0, agentId: null, signal: null, completedAt: "", data: options.schema?.parse({ result }) };
  }
  return partialFake<WorkflowContext>({ runId: "run-1", dispatch, historyNext: () => undefined, param: () => undefined });
}

const evidenceInput = (asked: Asked[]) => asked.find((entry) => entry.stepId.startsWith(MERGE_EVIDENCE_STEP))!.input;

describe("the CI-policy line across the review's own steps", () => {
  it("reaches the evidence step from an awaited MERGE", async () => {
    const asked: Asked[] = [];
    const awaited = { kind: "verdict" as const, verdict: "MERGE" as const, head: HEAD, locator, reviewer: REVIEWER, ciPolicy: UNCHANGED };

    await verdictOf(recordingCtx(asked, await evidenceFor(modified(CI_YML), UNCHANGED)), { repo: REPO, pr: 1, head: HEAD }, { repo: REPO, pr: 1, head: HEAD, external: "seat-rv" }, undefined, awaited);

    expect(evidenceInput(asked).ciPolicy).toEqual(UNCHANGED);
  });

  it("survives an unsettled re-read at the same head", async () => {
    const asked: Asked[] = [];
    const evidence = await evidenceFor(modified(CI_YML), UNCHANGED);

    await refreshMergeEvidence(recordingCtx(asked, evidence), evidence, undefined);

    expect(evidenceInput(asked).ciPolicy).toEqual(UNCHANGED);
  });
});
