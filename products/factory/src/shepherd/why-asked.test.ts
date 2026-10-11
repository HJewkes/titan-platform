import { describe, expect, it } from "vitest";
import { ESCALATIONS } from "./route-table.js";
import { closestUnmet, whyAsked } from "./why-asked.js";

const GATES = "the authority policy did not allow an automated merge: MRG-AU gates merge by automation";
const AUTHORITY = { table: "authority", rowId: "MRG-AU" };

describe("whyAsked for a seat owner-gate", () => {
  it("calls a Gate 2 visual registration deliberate and names its reason", () => {
    const why = whyAsked({ table: "shepherd-seat", rowId: "design-coord" }, "policy owner-gate waits", "gate-2-visual");

    expect(why).toMatchObject({ gateClass: "deliberate", ruleId: "shepherd-seat/design-coord" });
    expect(why.sentence).toContain("Gate 2 visual");
  });

  it("calls a seat with no reason a stale default", () => {
    const why = whyAsked({ table: "shepherd-seat", rowId: "none" }, "policy owner-gate waits");

    expect(why.gateClass).toBe("accidental");
    expect(why.sentence).toContain("stale default");
  });

  it("calls a proof fixture accidental, since it belongs in no owner round", () => {
    expect(whyAsked({ table: "shepherd-seat", rowId: "titan-coord" }, "", "proof-fixture").gateClass).toBe("accidental");
  });
});

describe("whyAsked for an authority gate", () => {
  it("calls a merge-tree-only failure a transient read and names its fix", () => {
    const why = whyAsked(AUTHORITY, `${GATES}; MRG-AU-RV unmet: merge-tree-clean; MRG-AU-RC unmet: verdict-merge-carried-tree-equal, merge-tree-clean`);

    expect(why).toMatchObject({ gateClass: "accidental", ruleId: "MRG-AU" });
    expect(why.sentence).toContain("transient merge-state read; TP-1688");
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
  it.each([
    ["github-path", "deliberate"],
    ["visual-path", "deliberate"],
    ["merge-state-unsettled", "accidental"],
    ["no-facts", "accidental"],
    ["head-mismatch", "accidental"],
    ["files-unread", "accidental"],
    ["required-checks-unknown", "accidental"],
  ])("labels merge guard %s %s", (rowId, gateClass) => {
    expect(whyAsked({ table: "shepherd-merge-guard", rowId }, "x").gateClass).toBe(gateClass);
  });

  it.each(Object.entries(ESCALATIONS).filter(([row]) => row !== "policy-denial"))("calls route escalation %s accidental with its count", (rowId, words) => {
    const why = whyAsked({ table: "shepherd-route", rowId }, "detail");

    expect(why.gateClass).toBe("accidental");
    expect(why.sentence).toContain(words);
  });

  it("labels a rule it does not know unclassified rather than guessing", () => {
    expect(whyAsked({ table: "shepherd-release", rowId: "batch" }, "x").gateClass).toBe("unclassified");
    expect(whyAsked({ table: "shepherd-merge-guard", rowId: "new-row" }, "x").gateClass).toBe("unclassified");
  });
});
