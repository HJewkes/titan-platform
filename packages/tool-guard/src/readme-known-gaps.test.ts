import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const README = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const SECTION = README.split(/^## /m).find((s) => s.startsWith("Known gaps (parked)")) ?? "";

const PARKED_TASKS = [
  "TP-2696", "TP-2700", "TP-2701", "TP-2702", "TP-2706", "TP-2708", "TP-2709", "TP-2711", "TP-2712",
  "TP-2272", "TP-2273", "TP-2274", "TP-1517", "TP-1621", "TP-1630", "TP-1631", "TP-1632",
];

describe("README known gaps", () => {
  it("has a parked-gaps section", () => {
    expect(SECTION).not.toBe("");
  });

  it.each(PARKED_TASKS)("lists %s", (task) => {
    expect(SECTION).toContain(`| ${task} |`);
  });

  it("lists the node-option findings from #1859", () => {
    expect(SECTION).toContain("PR #1859 F1");
    expect(SECTION).toContain("PR #1859 F2");
  });

  it("says the guard is not a security boundary and points at egress control", () => {
    expect(SECTION).toContain("not a security boundary");
    expect(SECTION).toContain("TP-3751");
  });
});
