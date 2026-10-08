import { describe, expect, it } from "vitest";
import type { Finding } from "./contract-findings.js";
import { excessOf, withStatus } from "./finding-rows.js";

const row = (id: string, excess: number | null): Finding => ({
  id,
  snapshotId: 1,
  rule: "r",
  tool: "check",
  severity: "warning",
  node: { id: "a.ts", kind: "file", name: "a.ts", path: "a.ts" },
  excess,
  message: "",
  provenance: { kind: "derived", source: "check/r" },
});

describe("excessOf", () => {
  it.each([
    ["metric-max", 150, 100, 1.5],
    [undefined, 150, 100, 1.5],
    ["metric-outlier", 12, 4, 3],
    ["metric-min", 40, 80, 2],
    ["metric-max", undefined, 100, null],
    ["metric-min", 40, undefined, null],
    ["metric-max", 5, 0, null],
    ["metric-max", 5, -1, null],
    ["metric-min", 0, 80, null],
    ["metric-min", -2, 80, null],
  ] as const)("reads %s value %s against %s as %s", (type, value, threshold, expected) => {
    expect(excessOf(type, value, threshold)).toBe(expected);
  });
});

describe("withStatus", () => {
  it("compares excess against the baseline, unmeasured or equal pairs as carryover", () => {
    const baseline = [row("up", 1.2), row("down", 1.5), row("same", 1.5), row("lost", null), row("gone", 2)];
    const current = [row("up", 1.5), row("down", 1.2), row("same", 1.5), row("lost", 3), row("fresh", 1)];

    const statuses = withStatus(current, baseline).map((f) => [f.id, f.status]);

    expect(statuses).toEqual([
      ["up", "worsened"],
      ["down", "improved"],
      ["same", "carryover"],
      ["lost", "carryover"],
      ["fresh", "new"],
      ["gone", "resolved"],
    ]);
  });
});
