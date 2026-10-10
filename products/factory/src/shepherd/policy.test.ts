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
const VISUAL_GLOBS = ["packages/ui/src/components/**", "**/*.stories.tsx"];
const DESIGN: Seat = { name: "design-seat", remotes: ["acme/design"], paths: {}, grants: [], visualPaths: VISUAL_GLOBS };
const BOOK: SeatBook = { seats: [GATED, TRUSTED, DESIGN], denied: ["parked-app", "acme/retired"] };

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

describe("a feature base", () => {
  it("is off unless the registration asks for it, and the land options read it from the policy", () => {
    const asked = effective("acme/gizmos", { featureBase: true });

    expect(effective("acme/gizmos")).not.toHaveProperty("featureBase");
    expect(asked.featureBase).toBe(true);
    expect(EffectivePolicySchema.parse(JSON.parse(JSON.stringify(asked)))).toEqual(asked);
    expect(shepherdLandOptions(() => effective("acme/gizmos")).featureBase?.()).toBe(false);
    expect(shepherdLandOptions(() => asked).featureBase?.()).toBe(true);
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

describe("an owner-gate request's reason", () => {
  it("refuses owner-gate with no reason and names the four reasons", () => {
    expect(() => effective("acme/widgets", { merge: "owner-gate" })).toThrow(RegistrationRefused);
    expect(() => effective("acme/widgets", { merge: "owner-gate" })).toThrow(/gate-2-visual, g10-security, proof-fixture, owner-asked/);
  });

  it("refuses a reason outside the closed set", () => {
    expect(() => effective("acme/widgets", { merge: "owner-gate", ownerGateReason: "because" })).toThrow(RegistrationRefused);
  });

  it("refuses a reason unless the merge is owner-gate", () => {
    expect(() => effective("acme/gizmos", { merge: "auto", ownerGateReason: "proof-fixture" })).toThrow(/applies only with merge owner-gate/);
    expect(() => effective("acme/gizmos", { ownerGateReason: "proof-fixture" })).toThrow(RegistrationRefused);
  });

  it("accepts a reason and stores it in the effective policy", () => {
    expect(effective("acme/widgets", { merge: "owner-gate", ownerGateReason: "g10-security" })).toMatchObject({ merge: "owner-gate", ownerGateReason: "g10-security" });
  });

  it("appends the reason to the gate prompt", () => {
    const policy = shepherdGatePolicy(effective("acme/widgets", { merge: "owner-gate", ownerGateReason: "gate-2-visual" }));

    expect(policy.decide("merge", { headSha: "a".repeat(40) }).reason).toContain("policy owner-gate (gate-2-visual) waits for the owner");
  });

  it("replays a legacy owner-gate policy with no reason", () => {
    const legacy = { merge: "owner-gate", mergeMethod: "squash", fixer: false, seat: "gated-seat" };

    const parsed = EffectivePolicySchema.parse(legacy);

    expect(parsed.ownerGateReason).toBeUndefined();
    expect(shepherdGatePolicy(parsed).decide("merge", { headSha: "a".repeat(40) }).reason).toContain("policy owner-gate waits for the owner");
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

  it("keeps a feature base only when both policies allow one", () => {
    const featureBase = { ...policy("auto", "t"), featureBase: true as const };

    expect(stricterPolicy(featureBase, featureBase).featureBase).toBe(true);
    expect(stricterPolicy(featureBase, policy("auto", "o"))).not.toHaveProperty("featureBase");
    expect(stricterPolicy(policy("auto", "t"), featureBase)).not.toHaveProperty("featureBase");
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

  it("allows a .github/ workflow change when authority allows (TP-1886)", () => {
    vi.mocked(evaluate).mockReturnValue({ verdict: "allow", ruleId: "MRG-AU-RV" });

    const decision = shepherdGatePolicy(effective("acme/gizmos"), reviewed(evidenceAt(HEAD, [".github/workflows/release.yml"]))).decide("merge", { headSha: HEAD });

    expect(decision).toMatchObject({ outcome: "allow", rule: { rowId: "MRG-AU-RV" } });
    expect(evaluate).toHaveBeenCalled();
  });

  it("never asks authority under owner-gate or never, so the table cannot lift the seat ceiling", () => {
    for (const merge of ["owner-gate", "never"] as const) {
      shepherdGatePolicy(effective("acme/gizmos", merge === "owner-gate" ? { merge, ownerGateReason: "owner-asked" } : { merge }), reviewed(evidenceAt(HEAD))).decide("merge", { headSha: HEAD });
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

describe("a seat with visual paths", () => {
  const NEXT_HEAD = "f".repeat(40);
  const decideAt = (head: string, changedPaths: string[], requested?: unknown) =>
    shepherdGatePolicy(effective("acme/design", requested), reviewed(evidenceAt(head, changedPaths))).decide("merge", { headSha: head });

  it("reaches merge:auto without the merge grant and carries its visual paths", () => {
    expect(effective("acme/design")).toMatchObject({ merge: "auto", visualPaths: VISUAL_GLOBS });
  });

  it("merges a non-visual PR on MERGE at the head and green checks, with no owner gate", () => {
    expect(decideAt(HEAD, ["scripts/build-tokens.ts", "package.json"])).toMatchObject({ outcome: "allow", rule: { rowId: "MRG-AU-RV" } });
  });

  it("gates a PR touching a component path and names the matched paths, before authority is asked", () => {
    const decision = decideAt(HEAD, ["scripts/a.ts", "packages/ui/src/components/Button.tsx", "src/Card.stories.tsx"]);

    expect(decision).toMatchObject({ outcome: "gate", rule: { rowId: "visual-path" } });
    expect(decision.reason).toContain("packages/ui/src/components/Button.tsx, src/Card.stories.tsx");
    expect(decision.reason).not.toContain("scripts/a.ts");
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("gates a visual path spelled in another case", () => {
    expect(decideAt(HEAD, ["Packages/UI/src/Components/Button.tsx"])).toMatchObject({ outcome: "gate", rule: { rowId: "visual-path" } });
  });

  it("gates a rename that moves a file out of a visual path", () => {
    expect(decideAt(HEAD, ["src/Button.tsx", "packages/ui/src/components/Button.tsx"])).toMatchObject({ outcome: "gate", reason: expect.stringContaining("packages/ui/src/components/Button.tsx") });
  });

  it("gates the head a later push added a visual file at, on the policy resolved at registration", () => {
    const reviews = new Map([HEAD, NEXT_HEAD].map((head, i) => [head, evidenceAt(head, i === 0 ? ["scripts/a.ts"] : ["scripts/a.ts", "packages/ui/src/components/Modal.tsx"])]));
    const options = shepherdLandOptions(() => effective("acme/design"), (head) => ({ kind: "MERGE", headSha: head, evidence: reviews.get(head) }));

    expect(options.policy.decide("merge", { headSha: HEAD }).outcome).toBe("allow");
    expect(options.policy.decide("merge", { headSha: NEXT_HEAD })).toMatchObject({ outcome: "gate", reason: expect.stringContaining("packages/ui/src/components/Modal.tsx") });
  });

  it("gates a head whose changed files could not be read, and says it counts as visual", () => {
    const evidence = { ...evidenceAt(HEAD, []), changedFilesUnread: "the changed files of acme/design#3 are unknown: the list is truncated" };

    const decision = shepherdGatePolicy(effective("acme/design"), reviewed(evidence)).decide("merge", { headSha: HEAD });

    expect(decision).toMatchObject({ outcome: "gate", rule: { rowId: "files-unread" }, reason: expect.stringContaining("the list is truncated, so the PR counts as visual") });
  });

  it("gates an empty changed-file list as unread", () => {
    expect(decideAt(HEAD, [])).toMatchObject({ outcome: "gate", rule: { rowId: "files-unread" } });
  });

  it("still gates a non-visual PR whose registration asked for owner-gate", () => {
    expect(decideAt(HEAD, ["scripts/a.ts"], { merge: "owner-gate", ownerGateReason: "owner-asked" }).outcome).toBe("gate");
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("leaves a seat without visual paths at today's ceiling, gating even a non-visual PR", () => {
    expect(effective("acme/widgets")).not.toHaveProperty("visualPaths");
    expect(shepherdGatePolicy(effective("acme/widgets"), reviewed(evidenceAt(HEAD))).decide("merge", { headSha: HEAD }).outcome).toBe("gate");
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("gates every path when the policy's globs cannot compile", () => {
    const policy: EffectivePolicy = { ...effective("acme/design"), visualPaths: ["{a,b}".repeat(40)] };

    expect(shepherdGatePolicy(policy, reviewed(evidenceAt(HEAD))).decide("merge", { headSha: HEAD })).toMatchObject({ outcome: "gate", rule: { rowId: "visual-path" } });
  });

  it("keeps the union of visual paths when a stricter policy narrows another", () => {
    const base: EffectivePolicy = { merge: "auto", mergeMethod: "squash", fixer: true, seat: "t" };

    expect(stricterPolicy({ ...base, visualPaths: ["a/**"] }, { ...base, visualPaths: ["b/**", "a/**"] }).visualPaths).toEqual(["a/**", "b/**"]);
    expect(stricterPolicy(base, { ...base, visualPaths: ["b/**"] }).visualPaths).toEqual(["b/**"]);
    expect(stricterPolicy(base, base)).not.toHaveProperty("visualPaths");
  });

  it("round-trips visual paths through the stored policy schema", () => {
    const policy = effective("acme/design");

    expect(EffectivePolicySchema.parse(JSON.parse(JSON.stringify(policy)))).toEqual(policy);
  });
});
