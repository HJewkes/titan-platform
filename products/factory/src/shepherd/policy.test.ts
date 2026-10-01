import { evaluate } from "@titan-design/authority";
import type * as Authority from "@titan-design/authority";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MergeEvidence } from "./merge-facts.js";
import type { Verdict } from "./phases.js";
import { EffectivePolicySchema, RegistrationRefused, resolveEffectivePolicy, shepherdGatePolicy, shepherdLandOptions, stricterPolicy, type EffectivePolicy } from "./policy.js";
import { lookupSeat, type Seat, type SeatBook } from "./seats.js";

vi.mock("@titan-design/authority", async (importOriginal) => {
  const actual = await importOriginal<typeof Authority>();
  return { ...actual, evaluate: vi.fn(actual.evaluate) };
});

afterEach(() => vi.mocked(evaluate).mockReset());

const GATED: Seat = { name: "gated-seat", remotes: ["acme/widgets"], paths: {}, grants: ["some-other-grant"] };
const TRUSTED: Seat = { name: "trusted-seat", remotes: ["acme/gizmos"], paths: {}, grants: ["merge-on-green-approve"] };
const BOOK: SeatBook = { seats: [GATED, TRUSTED], denied: ["parked-app", "acme/retired"] };

function effective(repo: string, requested?: unknown) {
  return resolveEffectivePolicy(lookupSeat(BOOK, repo), requested);
}

describe("resolveEffectivePolicy", () => {
  it("narrows merge:auto to owner-gate on a seat without the merge-on-green grant", () => {
    expect(effective("acme/widgets", { merge: "auto" }).merge).toBe("owner-gate");
  });

  it("allows merge:auto on a seat with the grant, and defaults to that ceiling", () => {
    expect(effective("acme/gizmos", { merge: "auto" }).merge).toBe("auto");
    expect(effective("acme/gizmos").merge).toBe("auto");
  });

  it("keeps a never request on an auto seat", () => {
    expect(effective("acme/gizmos", { merge: "never" }).merge).toBe("never");
  });

  it("gives an unknown repo owner-gate and no fixer even when it asks for more", () => {
    expect(effective("acme/unlisted", { merge: "auto", fixer: true })).toEqual({ merge: "owner-gate", mergeMethod: "squash", fixer: false, seat: "none" });
  });

  it("gives a seat repo a fixer unless the registration opts out", () => {
    expect(effective("acme/widgets").fixer).toBe(true);
    expect(effective("acme/widgets", { fixer: false }).fixer).toBe(false);
  });

  it("carries the requested merge method, reviewer and priority", () => {
    expect(effective("acme/widgets", { mergeMethod: "rebase", reviewer: "review-bot", priority: 2 })).toMatchObject({ mergeMethod: "rebase", reviewer: "review-bot", priority: 2, seat: "gated-seat" });
  });

  it.each(["acme/parked-app", "Acme/Retired"])("refuses %s, a denied repo", (repo) => {
    expect(() => effective(repo, { merge: "never" })).toThrow(RegistrationRefused);
  });

  it.each([
    ["an unknown merge mode", { merge: "yolo" }],
    ["a wrong-case merge mode", { merge: "Never" }],
    ["an unknown merge method", { mergeMethod: "fast-forward" }],
    ["a string fixer", { fixer: "false" }],
    ["a non-integer priority", { priority: 1.5 }],
    ["an empty reviewer", { reviewer: "" }],
    ["a whitespace reviewer", { reviewer: " " }],
    ["an unknown key", { merge: "never", autoMerge: true }],
    ["a request that is not an object", "never"],
  ])("refuses a request with %s instead of passing it through", (_case, requested) => {
    expect(() => effective("acme/gizmos", requested)).toThrow(RegistrationRefused);
  });
});

describe("shepherdGatePolicy", () => {
  it("denies a merge under never, gates it under owner-gate, and gates auto with no merge facts", () => {
    const decide = (repo: string, merge?: "never") => shepherdGatePolicy(effective(repo, merge && { merge })).decide("merge", { headSha: "a".repeat(40) });

    expect(decide("acme/gizmos", "never")).toMatchObject({ outcome: "deny", rule: { table: "shepherd-seat", rowId: "trusted-seat", version: 1 } });
    expect(decide("acme/widgets")).toMatchObject({ outcome: "gate", rule: { rowId: "gated-seat" } });
    expect(decide("acme/gizmos")).toMatchObject({ outcome: "gate", rule: { table: "shepherd-merge-guard", rowId: "no-facts" } });
    expect(decide("acme/unlisted").rule.rowId).toBe("none");
  });

  it("tells the owner the review at the decided head under owner-gate", () => {
    const head = "b".repeat(40);
    const policy = shepherdGatePolicy(effective("acme/widgets"), (headSha) => (headSha === head ? { kind: "MERGE", headSha, evidence: {} } : undefined));

    expect(policy.decide("merge", { headSha: head })).toMatchObject({ outcome: "gate", reason: expect.stringContaining("review at this head: MERGE") });
    expect(policy.decide("merge", { headSha: "c".repeat(40) }).reason).not.toContain("review at this head");
  });

  it("parses an effective policy back from JSON and refuses an unknown key", () => {
    const policy = effective("acme/gizmos");

    expect(EffectivePolicySchema.parse(JSON.parse(JSON.stringify(policy)))).toEqual(policy);
    expect(() => EffectivePolicySchema.parse({ ...policy, autoMerge: true })).toThrow();
  });
});

describe("stricterPolicy", () => {
  const policy = (merge: EffectivePolicy["merge"], seat: string, fixer = true): EffectivePolicy => ({ merge, mergeMethod: "rebase", fixer, seat });

  it.each([
    ["auto", "owner-gate", "owner-gate"],
    ["owner-gate", "auto", "owner-gate"],
    ["never", "auto", "never"],
    ["auto", "never", "never"],
  ] as const)("narrows %s by %s to %s", (trusted, other, merge) => {
    expect(stricterPolicy(policy(trusted, "t"), policy(other, "o")).merge).toBe(merge);
  });

  it("names the seat whose mode won, and keeps a fixer only when both allow one", () => {
    expect(stricterPolicy(policy("auto", "t"), policy("never", "o", false))).toEqual({ merge: "never", mergeMethod: "rebase", fixer: false, seat: "o" });
    expect(stricterPolicy(policy("never", "t", false), policy("never", "o")).seat).toBe("t");
  });
});

const HEAD = "d".repeat(40);
const REVIEWER = { agentId: "agent-rv-1", sessionId: "session-rv-1" };

/** Facts on which every MRG-AU-RV condition holds at HEAD. */
function evidenceAt(head: string, changedPaths = ["src/a.ts"]): MergeEvidence {
  const merge = {
    head,
    resolver: REVIEWER,
    dispatchedReviewer: REVIEWER,
    verdict: { value: "MERGE", head },
    requiredContexts: ["validate"],
    allowedApps: [15368],
    checkRuns: [{ name: "validate", appId: 15368, headSha: head, conclusion: "success" }],
    mergeTreeClean: true,
    repoFrozen: false,
    changedPaths,
    seatGrants: ["merge-on-green-approve"],
  };
  return { head, merge, record: { repo: "acme/gizmos", pr: 3, head, reviewer: REVIEWER } } as unknown as MergeEvidence;
}

const reviewed = (evidence: MergeEvidence) => (): Verdict => ({ kind: "MERGE", headSha: evidence.head, evidence });

describe("shepherdGatePolicy under merge:auto", () => {
  it("allows a merge only on MRG-AU-RV at the decided head", () => {
    const decision = shepherdGatePolicy(effective("acme/gizmos"), reviewed(evidenceAt(HEAD))).decide("merge", { headSha: HEAD });

    expect(decision).toMatchObject({ outcome: "allow", rule: { table: "authority", rowId: "MRG-AU-RV", version: 1 } });
  });

  it("gates when authority gates, with authority's reason naming the unmet condition", () => {
    const evidence = evidenceAt(HEAD);
    evidence.merge.repoFrozen = true;

    const decision = shepherdGatePolicy(effective("acme/gizmos"), reviewed(evidence)).decide("merge", { headSha: HEAD });

    expect(decision).toMatchObject({ outcome: "gate", rule: { table: "authority", rowId: "MRG-AU" }, reason: expect.stringContaining("repo-not-frozen") });
  });

  it("gates an allow from any rule other than MRG-AU-RV", () => {
    vi.mocked(evaluate).mockReturnValueOnce({ verdict: "allow", ruleId: "MRG-OTHER" });

    expect(shepherdGatePolicy(effective("acme/gizmos"), reviewed(evidenceAt(HEAD))).decide("merge", { headSha: HEAD }).outcome).toBe("gate");
  });

  it("gates facts a lookup hands back for another head", () => {
    const decision = shepherdGatePolicy(effective("acme/gizmos"), reviewed(evidenceAt(HEAD))).decide("merge", { headSha: "e".repeat(40) });

    expect(decision).toMatchObject({ outcome: "gate", rule: { rowId: "head-mismatch" } });
  });

  it("gates a .github/ path before authority is asked", () => {
    vi.mocked(evaluate).mockReturnValue({ verdict: "allow", ruleId: "MRG-AU-RV" });

    const decision = shepherdGatePolicy(effective("acme/gizmos"), reviewed(evidenceAt(HEAD, [".github/workflows/ci.yml"]))).decide("merge", { headSha: HEAD });

    expect(decision).toMatchObject({ outcome: "gate", rule: { rowId: "github-path" } });
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("never asks authority under owner-gate or never, so the table cannot lift the seat ceiling", () => {
    for (const merge of ["owner-gate", "never"] as const) {
      shepherdGatePolicy(effective("acme/gizmos", { merge }), reviewed(evidenceAt(HEAD))).decide("merge", { headSha: HEAD });
    }

    expect(evaluate).not.toHaveBeenCalled();
  });

  it("hands land the evidence record on an allow", () => {
    const evidence = evidenceAt(HEAD);
    const options = shepherdLandOptions(() => effective("acme/gizmos"), reviewed(evidence));
    const decision = options.policy.decide("merge", { headSha: HEAD });

    expect(options.allowEvidence!({ repo: "acme/gizmos", pr: 3, headSha: HEAD, decision })).toEqual(evidence.record);
  });
});
