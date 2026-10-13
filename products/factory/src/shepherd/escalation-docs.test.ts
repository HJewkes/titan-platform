import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ESCALATIONS } from "./route-table.js";

/** Every prose description of the approve-merge reasons; each must state the FIX_FIRST cap and check order route-table.ts enforces. */
const DOCS = ["../../README.md", "../../../../site/guides/shepherd.md"].map((path) => fileURLToPath(new URL(path, import.meta.url)));

/** The markdown bullet that names `key`, up to the next bullet or blank line. */
function bulletFor(doc: string, key: string): string {
  const lines = doc.split("\n");
  const start = lines.findIndex((line) => line.startsWith("- ") && line.includes(key));
  if (start < 0) return "";
  const end = lines.findIndex((line, index) => index > start && (line.startsWith("- ") || line.trim() === ""));
  return lines.slice(start, end < 0 ? undefined : end).join(" ").replace(/\s+/g, " ");
}

const CAP = ESCALATIONS["fix-first-runaway"].match(/^\d+/)![0];

describe.each(DOCS)("the escalation reasons in %s", (path) => {
  const doc = readFileSync(path, "utf8");

  it("give the FIX_FIRST cap and the planner route", () => {
    const runaway = bulletFor(doc, "fix-first-runaway`");

    expect(runaway).toMatch(new RegExp(`\\b${CAP}\\b`));
    expect(runaway).toContain("redesign or split");
  });

  it("check the runaway cap before no-progress", () => {
    expect(bulletFor(doc, "fix-first-runaway`")).toContain("checked before `no-progress`");
    expect(bulletFor(doc, "no-progress`")).not.toMatch(/checked before (the runaway cap|`fix-first-runaway`)/);
  });
});
