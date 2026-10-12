import { describe, expect, it } from "vitest";
import { decisionClassOf, policyRowOf } from "./decision-class.js";
import { SHEPHERD_POLICY_TABLE, shepherdGatePolicy, type EffectivePolicy } from "./shepherd/policy.js";

const HEAD = "a".repeat(40);

/** The seat policy's own gate reason, so a wording change there shows up here rather than silently reading D1. */
function seatPrompt(ownerGateReason?: EffectivePolicy["ownerGateReason"]): string {
  const effective: EffectivePolicy = { merge: "owner-gate", mergeMethod: "squash", fixer: true, seat: "example-seat", ...(ownerGateReason && { ownerGateReason }) };
  const decision = shepherdGatePolicy(effective).decide("merge", { headSha: HEAD });
  return `Merge PR #4 in example/widgets at head ${HEAD}? CI is green. Policy ${decision.rule.table}/${decision.rule.rowId}: ${decision.reason}`;
}

const byRow = (table: string, rowId: string, prompt = "") => decisionClassOf({ table, rowId, step: "approve-merge", prompt });

describe("decisionClassOf", () => {
  it.each([
    ["gate-2-visual", "D2"],
    ["owner-asked", "D19"],
    ["g10-security", "D1"],
    ["proof-fixture", "D1"],
    [undefined, "D1"],
  ] as const)("reads the seat policy's owner-gate reason %s as %s", (reason, expected) => {
    const prompt = seatPrompt(reason);
    const row = policyRowOf(prompt)!;

    expect(row.table).toBe(SHEPHERD_POLICY_TABLE);
    expect(decisionClassOf({ ...row, step: "approve-merge", prompt })).toBe(expected);
  });

  it.each([
    ["shepherd-merge-guard", "visual-path", "D2"],
    ["shepherd-merge-guard", "files-unread", "D2"],
    ["shepherd-merge-guard", "github-path", "D6"],
    ["shepherd-merge-guard", "ci-policy-weakened", "D21"],
    ["shepherd-merge-guard", "merge-state-unsettled", "D5"],
    ["shepherd-merge-guard", "no-facts", "D5"],
    ["shepherd-merge-guard", "head-mismatch", "D5"],
    ["shepherd-merge-guard", "required-checks-unknown", "D5"],
    ["authority", "MRG-AU-RV", "D4"],
    ["authority", "none", "D4"],
    ["shepherd-route", "failed-rounds", "D7"],
    ["shepherd-route", "fix-first-runaway", "D8"],
    ["shepherd-route", "no-progress", "D8"],
    ["shepherd-route", "conflict", "D9"],
    ["shepherd-route", "repair-budget", "D10"],
    ["shepherd-release", "no-preflight", "D11"],
    ["shepherd-release", "no-release-grant", "D11"],
  ])("maps %s/%s to %s", (table, rowId, expected) => {
    expect(byRow(table, rowId)).toBe(expected);
  });

  it("gives a carried policy denial the class of the seat policy it names", () => {
    expect(byRow("shepherd-route", "policy-denial", seatPrompt("owner-asked"))).toBe("D19");
  });

  it.each([
    ["main-red", "D13"],
    ["main-frozen", "D14"],
    ["main-red-again", "D14"],
    ["stuck-behind", "D15"],
    ["ci-failed", "D16"],
    ["sh-sent-back", "D16"],
  ])("maps step %s to %s when no policy row is named", (step, expected) => {
    expect(decisionClassOf({ step, prompt: "" })).toBe(expected);
  });

  it("leaves an unknown row and step unclassed", () => {
    expect(byRow("example-table", "merge-approval")).toBeUndefined();
    expect(decisionClassOf({ step: "device-confirm", prompt: "" })).toBeUndefined();
  });
});

describe("policyRowOf", () => {
  it("reads the row a conflict gate's prompt names", () => {
    expect(policyRowOf(`Merge PR #4 in example/widgets at head ${HEAD}? Policy shepherd-route/conflict: a merge conflict survived`)).toEqual({ table: "shepherd-route", rowId: "conflict" });
  });

  it("reads nothing from a prompt with no policy line", () => {
    expect(policyRowOf("CI failed twice on example/widgets#5.")).toBeUndefined();
  });
});
