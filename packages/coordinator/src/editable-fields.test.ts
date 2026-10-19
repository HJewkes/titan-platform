import { describe, expect, it } from "vitest";
import { EDITABLE_FIELDS, checkEditableValue, editableField } from "./editable-fields.js";

describe("EDITABLE_FIELDS", () => {
  it("holds every example row of the edit-flow table with its bounds", () => {
    const rows = EDITABLE_FIELDS.map((row) => [row.surface, row.pattern, row.bounds.min, row.bounds.max]);
    expect(rows).toEqual(
      expect.arrayContaining([
        ["coordinator", "seats.*.concurrency.implementers", 0, 64],
        ["coordinator", "seats.*.concurrency.reviewers", 0, 64],
        ["coordinator", "seats.*.concurrency.planners", 0, 64],
        ["coordinator", "seats.*.spend.*", 0, 1000],
        ["coordinator", "limits.pools.*.ceiling_five_hour", 0, 100],
        ["coordinator", "limits.pools.*.reserve_seven_day", 0, 100],
        ["agent-chat", "worktreeBudget", 1, 64],
        ["factory", "shepherd.spawnGate.load5", 1, 256],
      ]),
    );
  });

  it("gives every row a reload class", () => {
    expect(EDITABLE_FIELDS.every((row) => ["live", "per-spawn", "restart"].includes(row.reload))).toBe(true);
  });
});

describe("checkEditableValue", () => {
  it("accepts a seat cap inside its bounds", () => {
    const result = checkEditableValue("coordinator", "seats.web-coord.concurrency.implementers", 64);
    expect(result).toEqual(expect.objectContaining({ ok: true, value: 64 }));
  });

  it("refuses implementers: 65", () => {
    const result = checkEditableValue("coordinator", "seats.web-coord.concurrency.implementers", 65);
    expect(result).toEqual(expect.objectContaining({ ok: false, reason: "invalid" }));
  });

  it("refuses a fractional cap and a non-number", () => {
    expect(checkEditableValue("coordinator", "seats.a.concurrency.planners", 1.5).ok).toBe(false);
    expect(checkEditableValue("agent-chat", "worktreeBudget", "12").ok).toBe(false);
  });

  it("does not make grants_extra or any other seat field editable", () => {
    expect(editableField("coordinator", "seats.web-coord.grants_extra")).toBeUndefined();
    expect(editableField("coordinator", "seats.web-coord.pool")).toBeUndefined();
    expect(checkEditableValue("coordinator", "seats.web-coord.grants_extra", 1)).toEqual(
      expect.objectContaining({ ok: false, reason: "not-editable" }),
    );
  });

  it("matches a wildcard against exactly one segment", () => {
    expect(editableField("coordinator", "seats.a.b.concurrency.implementers")).toBeUndefined();
    expect(editableField("coordinator", "seats.a.spend.per_day_points.x")).toBeUndefined();
    expect(editableField("coordinator", "seats.a.spend.per_day_points")?.pattern).toBe("seats.*.spend.*");
  });

  it("keeps a path on the surface its row names", () => {
    expect(editableField("factory", "worktreeBudget")).toBeUndefined();
    expect(editableField("agent-chat", "worktreeBudget")?.surface).toBe("agent-chat");
  });
});
