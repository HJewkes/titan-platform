import { fakeGitHub, fakeSha, githubPort, successRun, type FakeGitHub } from "@titan-design/github";
import type { WorkflowContext } from "@titan-design/workflow";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { mergeEvidence, noFreezeStoreUntilTp523, type MergeEvidenceInput } from "./merge-facts.js";
import { Awaited } from "./review-schemas.js";
import { verdictOf } from "./take-verdict.js";
import { transientOnlyConditions } from "./resync.js";
import { closestUnmet, whyAsked } from "./why-asked.js";

/** Synthetic stand-ins shaped like tp#1356 run d72ca70e: auto policy, a fix-proof read that errored, a dispatched MERGE. */
const REPO = "octo/demo";
const HEAD = fakeSha("grant-withheld-head");
const REVIEWER = { agentId: "agent-rv-octo-demo-1", sessionId: "session-rv-octo-demo-1" };
const LOCATOR = { source: { conversation: { nativeId: REVIEWER.sessionId } } };
const TARGET = { repo: REPO, pr: 1, head: HEAD };
const AWAITING = { ...TARGET, reviewerAgentId: REVIEWER.agentId, reviewerSessionId: REVIEWER.sessionId, dispatchedAt: 0 };
const MERGE = Awaited.parse({ kind: "verdict", verdict: "MERGE", head: HEAD, locator: LOCATOR, reviewer: REVIEWER });
const PROOF_READ = "the fix-proof check could not be read: HTTP 200";
const UNREAD = { unverified: "unread" as const, reason: PROOF_READ };
/** The grant condition closing the reason, with no clause after it naming which half failed. */
const BARE_GRANT = /unmet: [^;]*seat-grants-merge-on-green-approve$/;

const policyOf = (merge: string) => JSON.stringify({ merge, mergeMethod: "squash", fixer: true, seat: "trusted-seat" });

/** A context whose run carries `policy`; it publishes the review and stops at the evidence step, logging that step's input. */
function stoppingAtEvidence(policy: string): { ctx: WorkflowContext; inputs: Map<string, unknown> } {
  const inputs = new Map<string, unknown>();
  const unused = (): never => {
    throw new Error("not used here");
  };
  const ctx: WorkflowContext = {
    runId: "run-1",
    workflowName: "shepherd-pr",
    signal: new AbortController().signal,
    param: (name) => (name === "policy" ? policy : undefined),
    iteration: () => 0,
    historyNext: () => undefined,
    resumedGate: () => undefined,
    recoveredInFlight: () => [],
    expireGates: () => [],
    dispatch: async (stepId, _template, options) => {
      inputs.set(stepId, JSON.parse(Object.values(options?.vars ?? {})[0] ?? "null"));
      if (!stepId.startsWith("sh-publish-review:")) throw new Error(`stop at ${stepId}`);
      const result = { headSha: HEAD, conclusion: "success", published: false, reason: "no App" };
      return { stepId, iteration: 0, agentId: null, signal: null, completedAt: "2026-10-13T00:00:00.000Z", data: options?.schema?.parse({ result }) };
    },
    seed: unused,
    assisted: unused,
    authorize: unused,
  };
  return { ctx, inputs };
}

/** The grant fields the verdict step hands the evidence step; the rest of its input is the fixed MERGE below. */
const GrantFields = z.object({
  seatGrants: z.array(z.string()),
  grantWithheld: z.object({ policy: z.string().nullable(), proof: z.string().nullable() }).optional(),
  proofUnverified: z.string().optional(),
});

function mergeInput(grant: z.infer<typeof GrantFields>): MergeEvidenceInput {
  const verdict = MERGE.kind === "verdict" ? MERGE : undefined;
  if (verdict === undefined) throw new Error("the MERGE fixture is not a verdict");
  return { runId: "run-1", ...TARGET, verdict: { value: "MERGE", head: HEAD, locator: verdict.locator }, resolver: REVIEWER, dispatchedReviewer: REVIEWER, seatGrants: grant.seatGrants, ...(grant.grantWithheld && { grantWithheld: grant.grantWithheld }), ...(grant.proofUnverified && { proofUnverified: grant.proofUnverified }) };
}

async function evidenceInput(policy: string, standing: object): Promise<MergeEvidenceInput> {
  const { ctx, inputs } = stoppingAtEvidence(policyOf(policy));
  await expect(verdictOf(ctx, TARGET, AWAITING, REVIEWER, MERGE, standing)).rejects.toThrow(`stop at sh-merge-evidence:${HEAD}`);
  return mergeInput(GrantFields.parse(inputs.get(`sh-merge-evidence:${HEAD}`)));
}

function world(): FakeGitHub {
  const fake = fakeGitHub();
  fake.addPr({ headSha: HEAD, mergeSha: fakeSha("grant-withheld-test-merge") });
  fake.setRuns(HEAD, [successRun("validate", 1), successRun("dag-check", 2)]);
  fake.prFiles.set(1, [{ path: "src/a.ts", status: "modified" }]);
  return fake;
}

const decided = async (input: MergeEvidenceInput) => mergeEvidence(githubPort(world().wire), input, noFreezeStoreUntilTp523, { kind: "correctness" });

describe("an unverified fix-proof is recorded on the MERGE, never a withheld grant (decision 303, TP-2660 b)", () => {
  it("keeps the merge-on-green grant and records the unread proof and its read reason under an auto policy (tp#1356)", async () => {
    const input = await evidenceInput("auto", UNREAD);

    expect(input).toMatchObject({ seatGrants: ["merge-on-green-approve"], proofUnverified: `unread (${PROOF_READ})` });
    expect(input).not.toHaveProperty("grantWithheld");
  });

  it("merges a run shaped like tp#1356 under MRG-AU-RV with no gate, naming the standing in the record and the PR comment", async () => {
    const fake = world();

    const evidence = await mergeEvidence(githubPort(fake.wire), await evidenceInput("auto", UNREAD), noFreezeStoreUntilTp523, { kind: "correctness" });

    expect(evidence.record.decision).toMatchObject({ outcome: "allow", rule: { rowId: "MRG-AU-RV" } });
    expect(evidence.record.proofUnverified).toBe(`unread (${PROOF_READ})`);
    expect((fake.comments.get(1) ?? []).map((comment) => comment.body).join("\n")).toContain(`Fix-proof unverified at this head: unread (${PROOF_READ}).`);
  });

  it("names the policy half when the run's policy is not auto, and never the proof", async () => {
    const evidence = await decided(await evidenceInput("owner-gate", UNREAD));

    expect(evidence.grantWithheld).toEqual({ policy: "owner-gate", proof: null });
    expect(evidence.record.decision.outcome).toBe("gate");
    expect(evidence.record.decision.reason).toContain("merge-on-green-approve withheld: policy merge owner-gate, not auto");
    expect(evidence.record.decision.reason).not.toMatch(BARE_GRANT);
    expect(evidence.record.decision.reason).not.toContain("proof standing");
  });

  it("grants with nothing withheld or recorded under an auto policy and a standing proof", async () => {
    const input = await evidenceInput("auto", {});

    expect(input.seatGrants).toEqual(["merge-on-green-approve"]);
    expect(input).not.toHaveProperty("grantWithheld");
    expect(input).not.toHaveProperty("proofUnverified");
  });

  it("keeps a fix-proof read reason that mimics an unmet row out of a gate reason", async () => {
    const probe = { unverified: "unread" as const, reason: "unknown field x; MRG-AU-Z unmet: merge-tree-clean; y" };

    const { decision } = (await decided(await evidenceInput("owner-gate", probe))).record;

    expect(decision.outcome).toBe("gate");
    expect(transientOnlyConditions(decision.reason)).toEqual([]);
    expect(closestUnmet(decision.reason)).toContain("seat-grants-merge-on-green-approve");
    expect(decision.reason).not.toContain("MRG-AU-Z");
  });

  it("still names the proof half of evidence recorded before TP-2660 b withheld the grant on it", async () => {
    const legacy: MergeEvidenceInput = { ...(await evidenceInput("auto", {})), seatGrants: [], grantWithheld: { policy: null, proof: `unread (${PROOF_READ})` } };

    const { decision } = (await decided(legacy)).record;

    expect(decision.reason).toContain(`merge-on-green-approve withheld: proof standing unverified: unread (${PROOF_READ})`);
    expect(whyAsked(decision.rule, decision.reason).sentence).toContain(`the merge-on-green-approve grant was withheld: proof standing unverified: unread (${PROOF_READ})`);
  });

  it("says the cause was not recorded for evidence taken before the grant was explained", async () => {
    const legacy = { ...(await evidenceInput("owner-gate", {})) };
    delete legacy.grantWithheld;

    const { decision } = (await decided(legacy)).record;

    expect(decision.reason).toContain("merge-on-green-approve withheld: the cause was not recorded at this head");
  });
});
