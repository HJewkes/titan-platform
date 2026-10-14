import type { MergeFacts } from "@titan-design/authority";
import { partialFake } from "@titan-design/test-kit";
import { describe, expect, it } from "vitest";
import type { EvidenceRecord, MergeEvidence } from "./merge-facts.js";
import type { Verdict } from "./phases.js";
import { shepherdLandOptions, type EffectivePolicy } from "./policy.js";
import type { Escalated, Escalation } from "./route-table.js";

const FIRED = "a".repeat(40);
const HEAD = "b".repeat(40);
const REVIEWER = { agentId: "agent-rv-1", sessionId: "session-rv-1" };
const AUTO: EffectivePolicy = { merge: "auto", mergeMethod: "squash", fixer: true, seat: "trusted-seat" };

/** Facts on which every MRG-AU-RV condition holds at `head`, for a MERGE the dispatched reviewer wrote at `reviewedAt`. */
function evidenceAt(head: string, reviewedAt = head, changedPaths = ["src/a.ts"]): MergeEvidence {
  const merge = {
    head,
    resolver: REVIEWER,
    dispatchedReviewer: REVIEWER,
    verdict: { value: "MERGE" as const, head: reviewedAt },
    requiredContexts: ["validate"],
    allowedApps: [15368],
    checkRuns: [{ name: "validate", appId: 15368, headSha: head, conclusion: "success" }],
    mergeTreeClean: true,
    repoFrozen: false,
    changedPaths,
    seatGrants: ["merge-on-green-approve"],
  };
  return partialFake<MergeEvidence>({ head, merge: partialFake<MergeFacts>(merge), record: partialFake<EvidenceRecord>({ repo: "acme/gizmos", pr: 3, head, reviewer: REVIEWER }) });
}

const carried = (escalation: Escalation): Escalated => ({ escalation, detail: `the last at ${FIRED}`, carriedFrom: FIRED });

function decideAt(verdict: Verdict, escalated: Escalated | undefined, policy: EffectivePolicy = AUTO) {
  return shepherdLandOptions(() => policy, () => verdict, () => escalated).policy.decide("merge", { headSha: HEAD });
}

const freshMerge: Verdict = { kind: "MERGE", headSha: HEAD, evidence: evidenceAt(HEAD), reviewerProfile: "bd-reviewer" };

describe("a carried review-loop escalation at a head with a fresh MERGE (decision 303, ac#823)", () => {
  it.each(["fix-first-runaway", "no-progress", "conflict"] as const)("allows the merge over a carried %s, recording the cleared rule and both heads", (escalation) => {
    const decision = decideAt(freshMerge, carried(escalation));

    expect(decision).toMatchObject({ outcome: "allow", rule: { table: "shepherd-route", rowId: `${escalation}/cleared-by-merge` } });
    expect(decision.reason).toContain(`MRG-AU-RV holds at ${HEAD}`);
    expect(decision.reason).toContain(`carried from head ${FIRED} is cleared by the dispatched reviewer's MERGE at head ${HEAD}`);
  });

  it("still gates an escalation some other route carried, such as a repair budget", () => {
    expect(decideAt(freshMerge, carried("repair-budget"))).toMatchObject({ outcome: "gate", rule: { table: "shepherd-route", rowId: "repair-budget" } });
  });
});

describe("a carried escalation whose head has no fresh MERGE still gates", () => {
  it("over a MERGE carried by tree from an older head, which authority allows under MRG-AU-RC", () => {
    const evidence = evidenceAt(HEAD, FIRED);
    evidence.merge.carry = { fromHead: FIRED, head: HEAD, headTree: "c".repeat(40), mergeTree: "c".repeat(40), rule: "tree-equal" };
    evidence.merge.kind = "correctness";

    const verdict: Verdict = { kind: "MERGE", headSha: HEAD, evidence };

    expect(decideAt(verdict, undefined)).toMatchObject({ outcome: "allow", rule: { rowId: "MRG-AU-RC" } });
    expect(decideAt(verdict, carried("fix-first-runaway"))).toMatchObject({ outcome: "gate", rule: { rowId: "fix-first-runaway" } });
  });

  it("over a MERGE carried across a merge-up", () => {
    const decision = decideAt({ ...freshMerge, mergeUpFrom: FIRED }, carried("no-progress"));

    expect(decision).toMatchObject({ outcome: "gate", rule: { rowId: "no-progress" } });
    expect(decision.reason).toContain(`carried from the gate at head ${FIRED}; review at this head: MERGE`);
  });

  it("over a fresh MERGE whose evidence was recorded at another head", () => {
    const evidence = evidenceAt(HEAD);
    evidence.record.head = FIRED;

    expect(decideAt({ kind: "MERGE", headSha: HEAD, evidence }, carried("fix-first-runaway")).outcome).toBe("gate");
  });

  it("when the head's own facts gate, as a visual path does", () => {
    const visual = decideAt({ ...freshMerge, evidence: evidenceAt(HEAD, HEAD, ["packages/ui/src/components/Beat.tsx"]) }, carried("fix-first-runaway"), { ...AUTO, visualPaths: ["packages/ui/src/components/**"] });

    expect(visual).toMatchObject({ outcome: "gate", rule: { table: "shepherd-route", rowId: "fix-first-runaway" } });
  });

  it("at the head where the escalation fired, whose review is FIX_FIRST", () => {
    const fired = decideAt({ kind: "FIX_FIRST", headSha: HEAD, text: "again" }, { escalation: "fix-first-runaway", detail: `the last at ${HEAD}` });

    expect(fired).toMatchObject({ outcome: "gate", rule: { table: "shepherd-route", rowId: "fix-first-runaway" } });
  });
});
