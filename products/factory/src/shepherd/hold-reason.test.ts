import { describe, expect, it } from "vitest";
import { HOLD_CLASSES, TASKLESS_CLASSES, HoldReasonSchema, checkHoldReason } from "./hold-reason.js";

const DEFECT_CLASSES = HOLD_CLASSES.filter((holdClass) => !TASKLESS_CLASSES.has(holdClass));

function refusalOf(reason: string): string {
  const check = checkHoldReason(reason);
  if (check.ok) throw new Error(`expected "${reason}" to be refused`);
  return check.refusal;
}

describe("checkHoldReason", () => {
  it("names the seven charter classes, three of them taskless", () => {
    expect(HOLD_CLASSES).toEqual(["serve-down", "stalled", "no-reviewer", "run-failed", "visual-gate2", "g10-review", "g10-adversary"]);
    expect([...TASKLESS_CLASSES]).toEqual(["visual-gate2", "g10-review", "g10-adversary"]);
  });

  it.each(HOLD_CLASSES)("accepts a %s hold that cites a task", (holdClass) => {
    expect(checkHoldReason(`${holdClass}: the step recorded none at abc1234; TP-1948`)).toEqual({ ok: true, holdClass });
  });

  it.each([...TASKLESS_CLASSES])("accepts a %s hold with no task ID", (holdClass) => {
    expect(checkHoldReason(`${holdClass}: owner sign-off quoted in the body at abc1234`)).toEqual({ ok: true, holdClass });
  });

  it.each(DEFECT_CLASSES)("refuses a %s hold with no task ID and names the task-ID rule", (holdClass) => {
    const refusal = refusalOf(`${holdClass}: the step recorded none since 05:51Z`);

    expect(refusal).toContain(`a ${holdClass} hold names no task ID`);
    expect(refusal).toContain("an ID like TP-123 or CC-45");
  });

  it.each([
    ["a seat path with a colon", "design interim procedure: coordinator reviewer then seat-merge"],
    ["a seat name as the class", "some-coord: factory serve down; TP-12"],
    ["no colon at all", "factory serve down; seat merges by hand; TP-12"],
    ["a class with a leading space", " no-reviewer: none; TP-12"],
    ["a class in another case", "No-Reviewer: none; TP-12"],
    ["a class with a space before the colon", "no-reviewer : none; TP-12"],
    ["a class that only starts like one", "no-reviewers: none; TP-12"],
  ])("refuses %s, listing every class", (_case, reason) => {
    const refusal = refusalOf(reason);

    expect(refusal).toContain("is not a hold class");
    for (const holdClass of HOLD_CLASSES) expect(refusal).toContain(holdClass);
    expect(refusal).toContain("A seat path or interim procedure is not a hold reason");
  });

  it.each(["TP-1", "CC-784", "TD-12", "VW-9001", "(TP-2112,", "TP-12."])("reads %s as a task ID", (id) => {
    expect(checkHoldReason(`run-failed: land-rules refuses ${id} trailing`).ok).toBe(true);
  });

  it.each(["tp-12", "TP12", "TP-", "XTP-12x", "abcdef-12"])("does not read %s as a task ID", (text) => {
    expect(checkHoldReason(`stalled: no step progress ${text}`).ok).toBe(false);
  });

  it.each([
    "",
    "; seat path: interim procedure via bin/merge",
    ": more: colons: here",
    "\nsecond line\twith a tab",
    " ".repeat(5000),
    " — ünïcode ✓ detail",
    "; no-task-yet; R-1",
  ])("never refuses a valid class with a task ID, whatever follows it (%#)", (suffix) => {
    for (const holdClass of HOLD_CLASSES) expect(checkHoldReason(`${holdClass}: detail; CC-45${suffix}`)).toEqual({ ok: true, holdClass });
  });
});

describe("HoldReasonSchema", () => {
  it("fails the parse with the refusal", () => {
    const parsed = HoldReasonSchema.safeParse("interim procedure");

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toContain("nothing was held");
  });

  it("refuses an empty reason", () => {
    expect(HoldReasonSchema.safeParse("").success).toBe(false);
  });

  it("passes a typed reason through unchanged", () => {
    expect(HoldReasonSchema.parse("g10-adversary: merge policy change; TP-1")).toBe("g10-adversary: merge policy change; TP-1");
  });
});
