import { evaluate } from "@titan-design/authority";
import type * as Authority from "@titan-design/authority";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mechanicalAuthorityReason } from "../coordinator-evidence.js";
import type { MergeEvidence } from "./merge-facts.js";
import type { Verdict } from "./phases.js";
import { EffectivePolicySchema, RegistrationRefused, resolveEffectivePolicy, shepherdGatePolicy, shepherdLandOptions, stricterPolicy, type EffectivePolicy } from "./policy.js";
import { escalationReason } from "./route-table.js";
import { lookupSeat, type Seat, type SeatBook } from "./seats.js";
import { partialFake } from "@titan-design/test-kit";

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
  const STACKED: Seat = { name: "stacked-seat", remotes: ["acme/stacks"], paths: {}, grants: ["merge-into-feature-base"] };
  const stacked = (requested?: unknown) => resolveEffectivePolicy(lookupSeat({ seats: [STACKED], denied: [] }, "acme/stacks"), requested);

  it("comes only from a seat's grant, and the land options read it from the policy", () => {
    expect(effective("acme/gizmos")).not.toHaveProperty("featureBase");
    expect(stacked().featureBase).toBe(true);
    expect(EffectivePolicySchema.parse(JSON.parse(JSON.stringify(stacked())))).toEqual(stacked());
    expect(shepherdLandOptions(() => effective("acme/gizmos")).featureBase?.()).toBe(false);
    expect(shepherdLandOptions(() => stacked()).featureBase?.()).toBe(true);
  });

  it("refuses a registration that asks for it, so an implementer cannot widen its seat", () => {
    expect(() => effective("acme/gizmos", { featureBase: true })).toThrow(RegistrationRefused);
    expect(() => stacked({ featureBase: false })).toThrow(/featureBase/);
  });
});

describe("the release-merge grant", () => {
  const RELEASER: Seat = { name: "release-seat", remotes: ["acme/releases"], paths: {}, grants: ["merge-on-green-approve", "release-merge"] };
  const releaser = (requested?: unknown) => resolveEffectivePolicy(lookupSeat({ seats: [RELEASER], denied: [] }, "acme/releases"), requested);

  it("comes only from a seat's release-merge grant, not from merge-on-green", () => {
    expect(effective("acme/gizmos")).not.toHaveProperty("release");
    expect(releaser().release).toBe("grant");
    expect(EffectivePolicySchema.parse(JSON.parse(JSON.stringify(releaser())))).toEqual(releaser());
  });

  it("refuses a registration that asks for it, so an implementer cannot widen its seat", () => {
    expect(() => effective("acme/gizmos", { release: "grant" })).toThrow(RegistrationRefused);
  });

  it("reads a stored run policy written before the field as having no grant", () => {
    const stored = EffectivePolicySchema.parse({ merge: "auto", mergeMethod: "squash", fixer: true, seat: "trusted-seat" });

    expect(stored).not.toHaveProperty("release");
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

  it("keeps a release grant only when both policies carry one", () => {
    const granted = { ...policy("auto", "t"), release: "grant" as const };

    expect(stricterPolicy(granted, granted).release).toBe("grant");
    expect(stricterPolicy(granted, policy("auto", "o"))).not.toHaveProperty("release");
    expect(stricterPolicy(policy("auto", "t"), granted)).not.toHaveProperty("release");
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
  return Object.assign(partialFake<MergeEvidence>(), { head, merge, record: { repo: "acme/gizmos", pr: 3, head, reviewer: REVIEWER } });
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

  it("allows a .github/ workflow change the reviewer calls CI-policy unchanged when authority allows (TP-1886, TP-2407)", () => {
    vi.mocked(evaluate).mockReturnValue({ verdict: "allow", ruleId: "MRG-AU-RV" });

    const decision = shepherdGatePolicy(effective("acme/gizmos"), reviewed({ ...evidenceAt(HEAD, [".github/workflows/release.yml"]), ciPolicy: { kind: "unchanged" } })).decide("merge", { headSha: HEAD });

    expect(decision).toMatchObject({ outcome: "allow", rule: { rowId: "MRG-AU-RV" } });
    expect(evaluate).toHaveBeenCalled();
  });

  it("gates github-path on stored evidence with no CI-policy line and a .github/ path, before asking authority", () => {
    const decision = shepherdGatePolicy(effective("acme/gizmos"), reviewed(evidenceAt(HEAD, [".github/workflows/release.yml"]))).decide("merge", { headSha: HEAD });

    expect(decision).toMatchObject({ outcome: "gate", rule: { table: "shepherd-merge-guard", rowId: "github-path" } });
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("never asks authority under owner-gate or never, so the table cannot lift the seat ceiling", () => {
    for (const merge of ["owner-gate", "never"] as const) {
      shepherdGatePolicy(effective("acme/gizmos", merge === "owner-gate" ? { merge, ownerGateReason: "owner-asked" } : { merge }), reviewed(evidenceAt(HEAD))).decide("merge", { headSha: HEAD });
    }

    expect(evaluate).not.toHaveBeenCalled();
  });

  it("gates a head the policy would allow on a merged-up MERGE when an escalation was carried to it, naming the carried gate and the review", () => {
    vi.mocked(evaluate).mockReturnValue({ verdict: "allow", ruleId: "MRG-AU-RV" });
    const carried = { escalation: "fix-first-runaway", detail: "the last at old", carriedFrom: "d".repeat(40) } as const;
    const mergedUp = (): Verdict => ({ kind: "MERGE", headSha: HEAD, evidence: evidenceAt(HEAD), mergeUpFrom: "c".repeat(40) });
    const options = shepherdLandOptions(() => effective("acme/gizmos"), mergedUp, () => carried);

    const decision = options.policy.decide("merge", { headSha: HEAD });

    expect(decision).toMatchObject({ outcome: "gate", rule: { table: "shepherd-route", rowId: "fix-first-runaway" } });
    expect(decision.reason).toContain(`carried from the gate at head ${carried.carriedFrom}; review at this head: MERGE`);
  });

  it("still allows a head the policy allows when its escalation was not carried", () => {
    vi.mocked(evaluate).mockReturnValue({ verdict: "allow", ruleId: "MRG-AU-RV" });
    const options = shepherdLandOptions(() => effective("acme/gizmos"), reviewed(evidenceAt(HEAD)), () => ({ escalation: "fix-first-runaway", detail: "x" }));

    expect(options.policy.decide("merge", { headSha: HEAD }).outcome).toBe("allow");
  });

  it("hands land the evidence record on an allow", () => {
    const evidence = evidenceAt(HEAD);
    const options = shepherdLandOptions(() => effective("acme/gizmos"), reviewed(evidence));
    const decision = options.policy.decide("merge", { headSha: HEAD });

    expect(options.allowEvidence!({ repo: "acme/gizmos", pr: 3, headSha: HEAD, decision })).toEqual(evidence.record);
  });
});

describe("merge evidence read on another base than the one being decided", () => {
  const onBase = (baseRef: string): MergeEvidence => {
    const evidence = evidenceAt(HEAD);
    return { ...evidence, record: { ...evidence.record, baseRef } };
  };

  it("gates a head MRG-AU-RV would allow when its evidence was read on the parent branch and main is being decided", () => {
    const options = shepherdLandOptions(() => effective("acme/gizmos"), reviewed(onBase("agent-chat/parent")), undefined, () => "main");

    const decision = options.policy.decide("merge", { headSha: HEAD });

    expect(decision).toMatchObject({ outcome: "gate", rule: { table: "shepherd-merge-guard", rowId: "no-facts" } });
    expect(decision.reason).toContain("read on base agent-chat/parent, not on main");
  });

  /** Main's evidence with a check still running, so MRG-AU gates on a reason a coordinator may resolve, its proof judged on `proofBase`. */
  const mechanicallyGated = (baseRef: string, proofBase: string): MergeEvidence => {
    const evidence = onBase(baseRef);
    evidence.merge.checkRuns = [{ name: "validate", appId: 15368, headSha: HEAD, conclusion: null }];
    return { ...evidence, record: { ...evidence.record, proofBase } };
  };

  it.each([
    ["the fix-proof judged the parent branch", mechanicallyGated("main", "agent-chat/parent"), "judged base agent-chat/parent, not main"],
    ["the merge facts were read on the parent branch", mechanicallyGated("agent-chat/parent", "main"), "read on base agent-chat/parent, not on main"],
  ])("turns a mechanical MRG-AU gate into a merge-guard gate when %s, so no coordinator resolves it into a merge", (_scene, evidence, offBase) => {
    const unguarded = shepherdGatePolicy(effective("acme/gizmos"), reviewed(evidence)).decide("merge", { headSha: HEAD });
    const options = shepherdLandOptions(() => effective("acme/gizmos"), reviewed(evidence), undefined, () => "main");

    const decision = options.policy.decide("merge", { headSha: HEAD });

    expect(unguarded).toMatchObject({ outcome: "gate", rule: { table: "authority", rowId: "MRG-AU" } });
    expect(mechanicalAuthorityReason(escalationReason("policy-denial", unguarded.reason))).toBe(true);
    expect(decision).toMatchObject({ outcome: "gate", rule: { table: "shepherd-merge-guard", rowId: "no-facts" } });
    expect(decision.reason).toContain(offBase);
    expect(decision.reason).toContain("no-non-green-run");
  });

  it("leaves a mechanical MRG-AU gate as it is when the facts and the fix-proof were both read on the base being decided", () => {
    const options = shepherdLandOptions(() => effective("acme/gizmos"), reviewed(mechanicallyGated("main", "main")), undefined, () => "main");

    expect(options.policy.decide("merge", { headSha: HEAD })).toMatchObject({ outcome: "gate", rule: { table: "authority", rowId: "MRG-AU" } });
  });

  const proved = (evidence: MergeEvidence, proofBase: string): MergeEvidence => ({ ...evidence, record: { ...evidence.record, proofBase } });

  it("allows when the evidence and the fix-proof were both read on the base being decided, or no base was checked", () => {
    expect(shepherdLandOptions(() => effective("acme/gizmos"), reviewed(proved(onBase("main"), "main")), undefined, () => "main").policy.decide("merge", { headSha: HEAD }).outcome).toBe("allow");
    expect(shepherdLandOptions(() => effective("acme/gizmos"), reviewed(onBase("agent-chat/parent"))).policy.decide("merge", { headSha: HEAD }).outcome).toBe("allow");
  });

  it("allows on main a MERGE whose record names no proof base: it was bound to none, so decision 303 governs it", () => {
    const decision = shepherdLandOptions(() => effective("acme/gizmos"), reviewed(onBase("main")), undefined, () => "main").policy.decide("merge", { headSha: HEAD });

    expect(decision).toMatchObject({ outcome: "allow", rule: { table: "authority", rowId: "MRG-AU-RV" } });
  });

  it("gates an allow on main whose MERGE record was bound to the parent branch, as no-facts", () => {
    const decision = shepherdLandOptions(() => effective("acme/gizmos"), reviewed(proved(onBase("main"), "agent-chat/parent")), undefined, () => "main").policy.decide("merge", { headSha: HEAD });

    expect(decision).toMatchObject({ outcome: "gate", rule: { table: "shepherd-merge-guard", rowId: "no-facts" } });
    expect(decision.reason).toContain(`the fix-proof at ${HEAD} judged base agent-chat/parent, not main`);
  });

  const onMain = (paths: string[], changedFilesUnread?: string): MergeEvidence => {
    const evidence = evidenceAt(HEAD, paths);
    return { ...evidence, ...(changedFilesUnread !== undefined && { changedFilesUnread }), record: { ...evidence.record, baseRef: "main", proofBase: "agent-chat/parent" } };
  };

  it.each([
    ["visual-path", "acme/design", ["packages/ui/src/components/Button.tsx"], undefined, "the owner decides visual changes: packages/ui/src/components/Button.tsx"],
    ["files-unread", "acme/gizmos", ["src/a.ts"], "the PR file list could not be read", "the PR file list could not be read"],
  ])("keeps a %s gate's own rule on an off-base proof, naming the proof first", (rowId, repo, paths, unread, own) => {
    const decision = shepherdLandOptions(() => effective(repo), reviewed(onMain(paths, unread)), undefined, () => "main").policy.decide("merge", { headSha: HEAD });

    expect(decision).toMatchObject({ outcome: "gate", rule: { table: "shepherd-merge-guard", rowId } });
    expect(decision.reason).toMatch(new RegExp(`the fix-proof at ${HEAD} judged base agent-chat/parent, not main, .*; ${own}`));
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

describe("a seat with visual baselines (TP-2662)", () => {
  const BASELINES = { check: "visual", paths: ["packages/ui/specimen/baseline/**"] };
  const BASELINED: Seat = { ...DESIGN, name: "baselined-seat", remotes: ["acme/baselined"], visualBaselines: BASELINES };
  const UNOPTED: Seat = { ...GATED, name: "unopted-seat", remotes: ["acme/unopted"], visualBaselines: BASELINES };
  const resolved = (seat: Seat) => resolveEffectivePolicy(lookupSeat({ seats: [seat], denied: [] }, seat.remotes[0]!));
  const base: EffectivePolicy = { merge: "auto", mergeMethod: "squash", fixer: true, seat: "t", visualPaths: VISUAL_GLOBS };
  const component = "packages/ui/src/components/Beat.tsx";

  /** MRG-AU-RV facts at HEAD with a Beat.tsx change and the baseline check green from GitHub Actions. */
  function clearedEvidence(changedPaths = [component]): MergeEvidence {
    const evidence = evidenceAt(HEAD, changedPaths);
    evidence.merge.checkRuns = [...evidence.merge.checkRuns, { name: "visual", appId: 15368, headSha: HEAD, conclusion: "success" }];
    return evidence;
  }

  it("carries the seat's baselines into the run policy, and none for a seat without visual paths", () => {
    expect(resolved(BASELINED)).toMatchObject({ visualPaths: VISUAL_GLOBS, visualBaselines: BASELINES });
    expect(resolved(UNOPTED)).not.toHaveProperty("visualBaselines");
  });

  it("round-trips baselines through the stored policy schema and refuses an unknown baseline key", () => {
    const policy = resolved(BASELINED);

    expect(EffectivePolicySchema.parse(JSON.parse(JSON.stringify(policy)))).toEqual(policy);
    expect(EffectivePolicySchema.safeParse({ ...policy, visualBaselines: { ...BASELINES, threshold: 1 } }).success).toBe(false);
  });

  it("keeps baselines in a stricter policy only when both sides carry the same ones", () => {
    const other = { check: "visual", paths: ["snapshots/**"] };

    expect(stricterPolicy({ ...base, visualBaselines: BASELINES }, { ...base, visualBaselines: { ...BASELINES } }).visualBaselines).toEqual(BASELINES);
    expect(stricterPolicy({ ...base, visualBaselines: BASELINES }, { ...base, visualBaselines: other })).not.toHaveProperty("visualBaselines");
    expect(stricterPolicy({ ...base, visualBaselines: BASELINES }, base)).not.toHaveProperty("visualBaselines");
    expect(stricterPolicy(base, { ...base, visualBaselines: BASELINES })).not.toHaveProperty("visualBaselines");
  });

  it("allows a visual head that changed no baseline on the green check, and gates one that changed a baseline", () => {
    const policy = resolved(BASELINED);
    const baseline = "packages/ui/specimen/baseline/beat/default-chromium-linux.png";

    const cleared = shepherdGatePolicy(policy, reviewed(clearedEvidence())).decide("merge", { headSha: HEAD });
    const changed = shepherdGatePolicy(policy, reviewed(clearedEvidence([component, baseline]))).decide("merge", { headSha: HEAD });

    expect(cleared).toMatchObject({ outcome: "allow", rule: { rowId: "MRG-AU-RV" }, reason: expect.stringContaining(`visual files ${component} changed no baseline and visual passed`) });
    expect(changed).toMatchObject({ outcome: "gate", rule: { rowId: "visual-path" }, reason: expect.stringContaining(baseline) });
  });
});
