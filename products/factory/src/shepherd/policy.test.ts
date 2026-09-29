import { describe, expect, it } from "vitest";
import { EffectivePolicySchema, RegistrationRefused, resolveEffectivePolicy, shepherdGatePolicy, stricterPolicy, type EffectivePolicy } from "./policy.js";
import { lookupSeat, type Seat, type SeatBook } from "./seats.js";

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
  it("denies a merge under never and gates it under owner-gate and auto", () => {
    const decide = (repo: string, merge?: "never") => shepherdGatePolicy(effective(repo, merge && { merge })).decide("merge", { headSha: "a".repeat(40) });

    expect(decide("acme/gizmos", "never")).toMatchObject({ outcome: "deny", rule: { table: "shepherd-seat", rowId: "trusted-seat", version: 1 } });
    expect(decide("acme/widgets").outcome).toBe("gate");
    expect(decide("acme/gizmos")).toMatchObject({ outcome: "gate", rule: { rowId: "trusted-seat" } });
    expect(decide("acme/unlisted").rule.rowId).toBe("none");
  });

  it("tells the owner the review at the decided head, and a MERGE review still only gates", () => {
    const head = "b".repeat(40);
    const policy = shepherdGatePolicy(effective("acme/gizmos"), (headSha) => (headSha === head ? { kind: "MERGE", headSha, evidence: {} } : undefined));

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
