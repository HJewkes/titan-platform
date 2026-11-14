import { describe, expect, it } from "vitest";
import type { GateDecision, PolicyRule } from "../gate-policy.js";
import { LIVE_FIELDS } from "../config-ref.js";
import { ownerValidateDecided, ownerValidateRefusal, ownerValidateStamp } from "./g10-owner-validate.js";
import type { PlanApproval, TaskApproval } from "./plan-approval.js";

const DONE_WHEN = "the demo widget renders its synthetic rows";
const TAGGED = { tags: ["owner-validate", "demo"], doneWhen: DONE_WHEN };
const UNTAGGED = { tags: ["demo"], doneWhen: DONE_WHEN };
const UNREAD = { unread: "active-work did not answer: connect ECONNREFUSED" };
const approvalFor = (doneWhen: string): TaskApproval => ({ gate: "task", scope: { doneWhen, reason: "new-direction", visualSignoff: false }, round: "round-1" });

const RULE: PolicyRule = { table: "shepherd-merge-guard", rowId: "owner-validate", version: 1 };
const ALLOW: GateDecision = { outcome: "allow", rule: { table: "authority", rowId: "MRG-AU-RV", version: 1 }, reason: "MRG-AU-RV holds at head" };
const stampOf = (mode: "shadow" | "on", read: Parameters<typeof ownerValidateStamp>[2]) => ownerValidateStamp(mode, "demo/TP-1", read).ownerValidate;

describe("owner-validate refusal", () => {
  it("an untagged task is dispatchable", () => {
    expect(ownerValidateRefusal(UNTAGGED, undefined)).toBeUndefined();
  });

  it("an owner-validate task with no approval is refused", () => {
    expect(ownerValidateRefusal(TAGGED, undefined)).toBe("no-approval");
  });

  it("an owner-validate task with an approval for its done_when is dispatchable", () => {
    expect(ownerValidateRefusal(TAGGED, approvalFor(DONE_WHEN))).toBeUndefined();
    expect(ownerValidateRefusal({ ...TAGGED, doneWhen: `  the demo widget\nrenders its synthetic rows ` }, approvalFor(DONE_WHEN))).toBeUndefined();
  });

  it("an approval for an older done_when is refused", () => {
    expect(ownerValidateRefusal(TAGGED, approvalFor("the demo widget renders"))).toBe("done-when-changed");
  });

  it("an unread task is refused", () => {
    expect(ownerValidateRefusal(UNREAD, approvalFor(DONE_WHEN))).toBe("task-unread");
  });
});

describe("the owner-validate merge stamp", () => {
  it("stamps a tagged or unread task and nothing for an untagged one", () => {
    expect(stampOf("on", TAGGED)).toEqual({ mode: "on", task: "demo/TP-1", tagged: true, doneWhen: DONE_WHEN });
    expect(stampOf("shadow", UNREAD)).toEqual({ mode: "shadow", task: "demo/TP-1", tagged: "unread", unread: UNREAD.unread });
    expect(stampOf("on", UNTAGGED)).toBeUndefined();
    expect(ownerValidateStamp("off", "demo/TP-1", TAGGED)).toEqual({});
  });

  it("a route that lost its mode wiring stamps on", () => {
    expect(ownerValidateStamp(undefined, "demo/TP-1", TAGGED).ownerValidate?.mode).toBe("on");
  });

  it("an absent config key reads as shadow at the config reader", () => {
    expect(LIVE_FIELDS["shepherd.gateReset.ownerValidate"]({})).toBe("shadow");
    expect(LIVE_FIELDS["shepherd.gateReset.ownerValidate"]({ gateReset: { ownerValidate: "on" } })).toBe("on");
  });
});

describe("the owner-validate guard row at decide time", () => {
  const approved = (doneWhen: string): PlanApproval[] => [{ gate: "skill", scope: { paths: ["skills/demo/SKILL.md"] }, round: "round-0" }, approvalFor(doneWhen)];

  it("under on, a tagged task with no task approval gates on owner-validate", () => {
    const decision = ownerValidateDecided(ALLOW, stampOf("on", TAGGED), [], RULE);

    expect(decision).toEqual({ outcome: "gate", rule: RULE, reason: expect.stringContaining("demo/TP-1 is tagged owner-validate and holds no owner task approval (no-approval)") });
  });

  it("under on, the owner's approval of the current done_when allows", () => {
    expect(ownerValidateDecided(ALLOW, stampOf("on", TAGGED), approved(DONE_WHEN), RULE)).toBe(ALLOW);
  });

  it("under on, an approval of an older done_when gates", () => {
    expect(ownerValidateDecided(ALLOW, stampOf("on", TAGGED), approved("an older done_when"), RULE)).toMatchObject({ outcome: "gate", reason: expect.stringContaining("(done-when-changed)") });
  });

  it("under on, an unread task gates even beside a task approval", () => {
    expect(ownerValidateDecided(ALLOW, stampOf("on", UNREAD), approved(DONE_WHEN), RULE)).toMatchObject({ outcome: "gate", reason: expect.stringContaining("(task-unread)") });
  });

  it("a malformed stamp, or one with an unknown mode, gates as an unread task under on", () => {
    expect(ownerValidateDecided(ALLOW, { mode: "on", task: "demo/TP-1", tagged: true }, approved(DONE_WHEN), RULE)).toMatchObject({ outcome: "gate", reason: expect.stringContaining("(task-unread)") });
    expect(ownerValidateDecided(ALLOW, { mode: "loud", task: "demo/TP-1", tagged: true, doneWhen: DONE_WHEN }, [], RULE)).toMatchObject({ outcome: "gate" });
  });

  it("under shadow, the allow stands and names the would-gate", () => {
    const decision = ownerValidateDecided(ALLOW, stampOf("shadow", TAGGED), [], RULE);

    expect(decision).toEqual({ ...ALLOW, reason: `${ALLOW.reason}; owner validate would gate: task demo/TP-1 is tagged owner-validate and holds no owner task approval (no-approval)` });
  });

  it("no stamp, or a decision that already gates, is left as it is", () => {
    const gate: GateDecision = { outcome: "gate", rule: RULE, reason: "another row" };

    expect(ownerValidateDecided(ALLOW, undefined, [], RULE)).toBe(ALLOW);
    expect(ownerValidateDecided(gate, stampOf("on", TAGGED), [], RULE)).toBe(gate);
  });
});
