import { describe, expect, it } from "vitest";
import { firstCode, parkUpdate } from "./stall.js";
import { LADDER_CODES, STALL_CODES } from "./vocab.js";

describe("stall code precedence", () => {
  it("picks the earlier code when several hold", () => {
    expect(firstCode(["no-progress", "dirty-uncommitted", "lease-expired"])).toBe("dirty-uncommitted");
  });

  it("ranks each code above every code after it, whatever the input order", () => {
    const winners = STALL_CODES.map((_, i) => firstCode([...STALL_CODES.slice(i)].reverse()));

    expect(winners).toEqual(STALL_CODES);
  });

  it("gives no code when none holds", () => {
    expect(firstCode([])).toBeUndefined();
  });

  it("leaves the owner-only codes off the ladder, retry-spent among them", () => {
    expect(STALL_CODES.filter((code) => !LADDER_CODES.includes(code))).toEqual([
      "shepherd-ended",
      "planner-refused",
      "retry-spent",
      "budget",
      "outside-owns",
      "no-repo",
    ]);
    expect(firstCode(["no-progress", "retry-spent"])).toBe("retry-spent");
  });

  it("has budget as a code and keeps it off the ladder", () => {
    expect(STALL_CODES).toContain("budget");
    expect(LADDER_CODES).not.toContain("budget");
    expect(STALL_CODES.indexOf("budget")).toBe(STALL_CODES.indexOf("retry-spent") + 1);
  });

  it("parks a no-repo claim as failed", () => {
    expect(parkUpdate({ taskId: "TX-1" }, "no-repo", "example/missing").patch.stalledClass).toBe("failed");
  });

  it("builds the park update with the class of its code", () => {
    expect(parkUpdate({ taskId: "TX-1", slice: "s2" }, "retry-spent", "refused 3/3")).toEqual({
      kind: "update",
      key: { taskId: "TX-1", slice: "s2" },
      patch: { stalledReason: "retry-spent: refused 3/3", stalledClass: "failed", stallCode: "retry-spent" },
    });
  });
});
