import { fakeGitHub, fakeSha, githubPort, successRun, type CheckRun, type FakeGitHub } from "@titan-design/github";
import { describe, expect, it } from "vitest";
import { fakeLocator } from "../test-support/fakes.js";
import { mergeEvidence, noFreezeStoreUntilTp523, type MergeEvidenceInput } from "./merge-facts.js";

const REPO = "octo/demo";
const HEAD = fakeSha("edit-run-head");
const REVIEWER = { agentId: "agent-rv-1", sessionId: "session-rv-1" };
const FIX_PROOF_JOBS = ["fix-proof-base", "fix-proof-head", "fix-proof-mutants", "fix-proof"] as const;
const REAL_RUN = 7001;
const EDIT_RUN = 7002;

const input: MergeEvidenceInput = {
  runId: "run-1", repo: REPO, pr: 1, head: HEAD,
  verdict: { value: "MERGE", head: HEAD, locator: fakeLocator({ sourceId: "transcript-1", selector: { kind: "subrecord-text" } }) },
  resolver: REVIEWER, dispatchedReviewer: REVIEWER, seatGrants: ["merge-on-green-approve"],
};

/** One job of one fix-proof workflow run; `startedAt` follows the run order, as GitHub's does. */
function job(name: string, id: number, workflowRunId: number, conclusion: string, startedAt: string): CheckRun {
  return { ...successRun(name, id, startedAt, conclusion, undefined, HEAD), workflowRunId };
}

/** The real run's jobs start first; the edit run's skips start seconds later, all but the judge, which waits on `needs:`. */
function realRun(conclusions: Partial<Record<(typeof FIX_PROOF_JOBS)[number], string>> = {}): CheckRun[] {
  return FIX_PROOF_JOBS.map((name, index) => job(name, 10 + index, REAL_RUN, conclusions[name] ?? "success", name === "fix-proof" ? "2026-01-01T00:04:00Z" : "2026-01-01T00:00:00Z"));
}

function editRun(names: readonly string[] = FIX_PROOF_JOBS): CheckRun[] {
  return names.map((name, index) => job(name, 20 + index, EDIT_RUN, "skipped", "2026-01-01T00:00:15Z"));
}

function world(fixProofRuns: CheckRun[]): FakeGitHub {
  const fake = fakeGitHub();
  fake.addPr({ headSha: HEAD, mergeSha: fakeSha("edit-run-test-merge") });
  fake.rules = { contexts: ["validate", ...FIX_PROOF_JOBS], strict: true };
  fake.setRuns(HEAD, [successRun("validate", 1, undefined, undefined, undefined, HEAD), ...fixProofRuns]);
  fake.prFiles.set(1, [{ path: "src/a.ts", status: "modified" }]);
  return fake;
}

async function record(fake: FakeGitHub) {
  return (await mergeEvidence(githubPort(fake.wire), input, noFreezeStoreUntilTp523, { kind: "correctness" }, undefined, { ownerTier: "off" })).record;
}

async function decide(fake: FakeGitHub) {
  return (await record(fake)).decision;
}

describe("merge facts after a no-op edit fix-proof run", () => {
  it("allows under MRG-AU-RV when a title edit's all-skipped run follows a green real run", async () => {
    const fake = world([...realRun(), ...editRun()]);

    const decision = await decide(fake);

    expect(decision).toMatchObject({ outcome: "allow", rule: { rowId: "MRG-AU-RV" } });
  });

  it("stays red when the real run's mutants job failed before the edit run skipped it", async () => {
    const fake = world([...realRun({ "fix-proof-mutants": "failure", "fix-proof": "failure" }), ...editRun()]);

    const { decision, checkRuns } = await record(fake);

    expect(decision.outcome).toBe("gate");
    expect(decision.reason).toContain("required-contexts-green");
    expect(checkRuns.find((run) => run.name === "fix-proof-mutants")).toMatchObject({ id: 12, conclusion: "failure" });
  });

  it("gates on a real run whose own mutants job skipped beside base and head jobs that ran", async () => {
    const fake = world(realRun({ "fix-proof-mutants": "skipped" }));

    const decision = await decide(fake);

    expect(decision.outcome).toBe("gate");
    expect(decision.reason).toContain("required-contexts-green");
  });

  it("gates on an all-skipped run with no earlier real run at the head", async () => {
    const fake = world(editRun());

    const decision = await decide(fake);

    expect(decision.outcome).toBe("gate");
    expect(decision.reason).toContain("required-contexts-green");
  });

  it("keeps a later run's skips when that run did not skip every fix-proof job", async () => {
    const partial = [...editRun(["fix-proof-base", "fix-proof-head", "fix-proof-mutants"]), job("fix-proof", 23, EDIT_RUN, "success", "2026-01-01T00:05:00Z")];
    const fake = world([...realRun(), ...partial]);

    const decision = await decide(fake);

    expect(decision.outcome).toBe("gate");
    expect(decision.reason).toContain("required-contexts-green");
  });
});
