import { fakeGitHub, fakeSha, githubPort, successRun, type FakeGitHub } from "@titan-design/github";
import type { WorkflowContext } from "@titan-design/workflow";
import { describe, expect, it } from "vitest";
import { mergeEvidence, noFreezeStoreUntilTp523, type MergeEvidenceInput } from "./merge-facts.js";
import { verdictOf, type AwaitedResult } from "./take-verdict.js";
import { whyAsked } from "./why-asked.js";

/** Synthetic stand-ins shaped like tp#1356 run d72ca70e: auto policy, a fix-proof read that errored, a dispatched MERGE. */
const REPO = "octo/demo";
const HEAD = fakeSha("grant-withheld-head");
const REVIEWER = { agentId: "agent-rv-octo-demo-1", sessionId: "session-rv-octo-demo-1" };
const LOCATOR = { source: { conversation: { nativeId: REVIEWER.sessionId } } };
const TARGET = { repo: REPO, pr: 1, head: HEAD };
const AWAITING = { ...TARGET, reviewerAgentId: REVIEWER.agentId, reviewerSessionId: REVIEWER.sessionId, dispatchedAt: 0 };
const MERGE = { kind: "verdict", verdict: "MERGE", head: HEAD, locator: LOCATOR, reviewer: REVIEWER } as AwaitedResult;
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

async function evidenceInput(policy: string, standing: object): Promise<MergeEvidenceInput> {
  const { ctx, inputs } = stoppingAtEvidence(policyOf(policy));
  await expect(verdictOf(ctx, TARGET, AWAITING, REVIEWER, MERGE, standing)).rejects.toThrow(`stop at sh-merge-evidence:${HEAD}`);
  return inputs.get(`sh-merge-evidence:${HEAD}`) as MergeEvidenceInput;
}

function world(): FakeGitHub {
  const fake = fakeGitHub();
  fake.addPr({ headSha: HEAD, mergeSha: fakeSha("grant-withheld-test-merge") });
  fake.setRuns(HEAD, [successRun("validate", 1)]);
  fake.prFiles.set(1, [{ path: "src/a.ts", status: "modified" }]);
  return fake;
}

const decided = async (input: MergeEvidenceInput) => mergeEvidence(githubPort(world().wire), input, noFreezeStoreUntilTp523, { kind: "correctness" });

describe("a MERGE whose merge-on-green grant is withheld names the half that failed", () => {
  it("records the unread fix-proof and its read reason when an auto policy's proof is unverified (tp#1356)", async () => {
    const input = await evidenceInput("auto", UNREAD);

    expect(input).toMatchObject({ seatGrants: [], grantWithheld: { policy: null, proof: `unread (${PROOF_READ})` } });
  });

  it("names the proof standing in the gate reason and the owner's why-asked sentence, never the bare condition", async () => {
    const evidence = await decided(await evidenceInput("auto", UNREAD));
    const { decision } = evidence.record;

    expect(evidence.grantWithheld).toEqual({ policy: null, proof: `unread (${PROOF_READ})` });
    expect(decision.outcome).toBe("gate");
    expect(decision.reason).toContain(`merge-on-green-approve withheld: proof standing unverified: unread (${PROOF_READ})`);
    expect(decision.reason).not.toMatch(BARE_GRANT);
    expect(whyAsked(decision.rule, decision.reason).sentence).toContain(`the merge-on-green-approve grant was withheld: proof standing unverified: unread (${PROOF_READ})`);
  });

  it("names the policy half when the run's policy is not auto and the proof stands", async () => {
    const evidence = await decided(await evidenceInput("owner-gate", {}));

    expect(evidence.grantWithheld).toEqual({ policy: "owner-gate", proof: null });
    expect(evidence.record.decision.reason).toContain("merge-on-green-approve withheld: policy merge owner-gate, not auto");
  });

  it("grants with nothing withheld under an auto policy and a standing proof", async () => {
    const input = await evidenceInput("auto", {});

    expect(input.seatGrants).toEqual(["merge-on-green-approve"]);
    expect(input).not.toHaveProperty("grantWithheld");
  });

  it("says the cause was not recorded for evidence taken before the grant was explained", async () => {
    const legacy = { ...(await evidenceInput("auto", UNREAD)) };
    delete legacy.grantWithheld;

    const { decision } = (await decided(legacy)).record;

    expect(decision.reason).toContain("merge-on-green-approve withheld: the cause was not recorded at this head");
  });
});
