import { describe, expect, it } from "vitest";
import { RegistrationRefused, resolveEffectivePolicy, shepherdGatePolicy } from "./policy.js";
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
});
