import { describe, expect, it } from "vitest";
import { MERGE_GUARD_ROWS } from "./merge-facts.js";
import { ESCALATIONS } from "./route-table.js";
import { closestUnmet, whyAsked } from "./why-asked.js";

const GATES = "the authority policy did not allow an automated merge: MRG-AU gates merge by automation";
const AUTHORITY = { table: "authority", rowId: "MRG-AU" };

describe("whyAsked for a seat owner-gate", () => {
  it("calls a Gate 2 visual registration deliberate and names its reason", () => {
    const why = whyAsked({ table: "shepherd-seat", rowId: "design-coord" }, "policy owner-gate waits", { ownerGateReason: "gate-2-visual" });

    expect(why).toMatchObject({ gateClass: "deliberate", ruleId: "shepherd-seat/design-coord" });
    expect(why.sentence).toContain("Gate 2 visual");
  });

  it("calls a seat with no reason a stale default", () => {
    const why = whyAsked({ table: "shepherd-seat", rowId: "none" }, "policy owner-gate waits");

    expect(why.gateClass).toBe("accidental");
    expect(why.sentence).toContain("no recorded reason");
  });

  it("calls a proof fixture accidental, since it belongs in no owner round", () => {
    expect(whyAsked({ table: "shepherd-seat", rowId: "titan-coord" }, "", { ownerGateReason: "proof-fixture" }).gateClass).toBe("accidental");
  });
});

describe("whyAsked for an authority gate", () => {
  const MERGE_TREE_ONLY = `${GATES}; MRG-AU-RV unmet: merge-tree-clean; MRG-AU-RC unmet: verdict-merge-carried-tree-equal, merge-tree-clean`;

  it("calls a merge-tree-only failure on an unknown mergeable_state a transient read and names its fix", () => {
    const why = whyAsked(AUTHORITY, MERGE_TREE_ONLY, { mergeableState: "unknown" });

    expect(why).toMatchObject({ gateClass: "accidental", ruleId: "MRG-AU" });
    expect(why.sentence).toContain("TP-1688 settles this transient merge-state read");
  });

  it.each([
    ["dirty", "conflicts with its base"],
    ["behind", "behind its base"],
    ["blocked", "not a bypassable review rule"],
  ])("names a merge-tree-only failure on mergeable_state %s as a real block, not a transient read", (mergeableState, words) => {
    const why = whyAsked(AUTHORITY, MERGE_TREE_ONLY, { mergeableState });

    expect(why.gateClass).toBe("deliberate");
    expect(why.sentence).toContain(words);
    expect(why.sentence).not.toContain("transient");
  });

  it("calls a merge-tree-only failure on a mergeable state with no test merge a moved head, not a conflict", () => {
    const why = whyAsked(AUTHORITY, MERGE_TREE_ONLY, { mergeableState: "clean" });

    expect(why.gateClass).toBe("accidental");
    expect(why.sentence).toContain("the head moved");
  });

  it("leaves a merge-tree-only failure with no recorded mergeable_state unclassified", () => {
    expect(whyAsked(AUTHORITY, MERGE_TREE_ONLY).gateClass).toBe("unclassified");
  });

  it("names the closest row's lasting conditions in plain words", () => {
    const why = whyAsked(AUTHORITY, `${GATES}; MRG-AU-RV unmet: required-contexts-green; MRG-AU-RC unmet: verdict-merge-carried-tree-equal, required-contexts-green`);

    expect(why.gateClass).toBe("deliberate");
    expect(why.sentence).toContain("a required check is not green");
    expect(why.sentence).not.toContain("carried");
  });

  it("does not call a missing verdict transient even when merge-tree-clean also failed", () => {
    expect(whyAsked(AUTHORITY, `${GATES}; MRG-AU-RV unmet: verdict-merge-at-head, merge-tree-clean`).gateClass).toBe("deliberate");
  });

  it("keeps an unknown condition id visible in backticks", () => {
    expect(closestUnmet(`${GATES}; MRG-AU-RV unmet: new-condition`)).toEqual(["new-condition"]);
    expect(whyAsked(AUTHORITY, `${GATES}; MRG-AU-RV unmet: new-condition`).sentence).toContain("`new-condition` is unmet");
  });
});

describe("whyAsked for Shepherd's own rows", () => {
  it.each(MERGE_GUARD_ROWS)("words merge guard row %s, so no row merge-facts emits reads as unclassified", (rowId) => {
    expect(whyAsked({ table: "shepherd-merge-guard", rowId }, "x").gateClass).not.toBe("unclassified");
  });

  it.each([
    ["skill-path", "deliberate"],
    ["visual-path", "deliberate"],
    ["merge-state-unsettled", "accidental"],
    ["no-facts", "accidental"],
    ["head-mismatch", "accidental"],
    ["files-unread", "accidental"],
    ["required-checks-unknown", "accidental"],
    ["github-path", "accidental"],
    ["ci-policy-weakened", "deliberate"],
    ["ci-policy-malformed", "accidental"],
  ])("labels merge guard %s %s", (rowId, gateClass) => {
    expect(whyAsked({ table: "shepherd-merge-guard", rowId }, "x").gateClass).toBe(gateClass);
  });

  it.each(Object.entries(ESCALATIONS).filter(([row]) => row !== "policy-denial"))("calls route escalation %s accidental with its count", (rowId, words) => {
    const why = whyAsked({ table: "shepherd-route", rowId }, "detail");

    expect(why.gateClass).toBe("accidental");
    expect(why.sentence).toContain(words);
  });

  it.each([
    ["shepherd-release", "owner-gate", "deliberate"],
    ["shepherd-release", "no-preflight", "accidental"],
    ["shepherd-release", "preflight-blocked", "accidental"],
    ["factory-default", "gate-all", "accidental"],
  ])("labels %s/%s %s", (table, rowId, gateClass) => {
    expect(whyAsked({ table, rowId }, "x").gateClass).toBe(gateClass);
  });

  it("labels a rule it does not know unclassified rather than guessing", () => {
    expect(whyAsked({ table: "shepherd-release", rowId: "new-row" }, "x").gateClass).toBe("unclassified");
    expect(whyAsked({ table: "shepherd-merge-guard", rowId: "new-row" }, "x").gateClass).toBe("unclassified");
  });
});
