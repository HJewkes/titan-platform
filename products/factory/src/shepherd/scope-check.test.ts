import { describe, expect, it } from "vitest";
import { blockingItems, scopeViolations } from "./scope-check.js";

const HUNKS = [
  { path: "packages/tool-guard/src/deny-rules.ts", start: 10, end: 11 },
  { path: "packages/tool-guard/src/lexer.ts", start: 40, end: 39 },
];
const POSTED = ["1. A quoted `git` word still slips past the deny rule.\n\nDefect class: unnormalised command words.\n\nVerdict: FIX_FIRST"];
const fixFirst = (items: string) => `${items}\n\nDefect class: unnormalised command words.\n\nVerdict: FIX_FIRST\nPR: octo/demo#1\nHead: ${"a".repeat(40)}\n`;

describe("scopeViolations", () => {
  it("flags a new item that cites only a line outside the fix's ranges and carries no tag", () => {
    const text = fixFirst("1. The alias table is never cleared at deny-rules.ts:900.");

    expect(scopeViolations(text, HUNKS, POSTED)).toEqual({ untagged: ["1. The alias table is never cleared at deny-rules.ts:900."], repeated: [] });
  });

  it("allows an out-of-range item that starts with Important: and names its Class:", () => {
    const text = fixFirst("1. **Important:** the alias table is never cleared at deny-rules.ts:900.\n   Class: stale state across calls");

    expect(scopeViolations(text, HUNKS, POSTED)).toEqual({ untagged: [], repeated: [] });
  });

  it("still flags an Important: item that names no Class:", () => {
    const text = fixFirst("1. Important: the alias table is never cleared at deny-rules.ts:900.");

    expect(scopeViolations(text, HUNKS, POSTED).untagged).toHaveLength(1);
  });

  it("flags nothing for an item whose cite falls inside the fix's ranges, a deletion point included", () => {
    const text = fixFirst("1. The new branch at packages/tool-guard/src/deny-rules.ts:11 drops `sudo`.\n2. The removed guard at lexer.ts:41 was load-bearing.");

    expect(scopeViolations(text, HUNKS, POSTED)).toEqual({ untagged: [], repeated: [] });
  });

  it("flags nothing for an item with no cite, which cannot be placed", () => {
    expect(scopeViolations(fixFirst("1. The tests never run the quoted case."), HUNKS, POSTED)).toEqual({ untagged: [], repeated: [] });
  });

  it("flags a new item equal to an earlier finding once case, punctuation and spacing are dropped", () => {
    const text = fixFirst("2. a QUOTED git word   still slips past the deny-rule!");

    expect(scopeViolations(text, HUNKS, POSTED)).toEqual({ untagged: [], repeated: ["2. a QUOTED git word   still slips past the deny-rule!"] });
  });

  it("never reads the earlier-findings checklist or the defect-class section as new items", () => {
    const text = fixFirst("1. The new branch at deny-rules.ts:10 drops `sudo`.\n\nEarlier findings:\n- not fixed: A quoted `git` word still slips past the deny rule.\n- fixed: The old case at deny-rules.ts:300.");

    expect(scopeViolations(text, HUNKS, POSTED)).toEqual({ untagged: [], repeated: [] });
  });
});

describe("blockingItems", () => {
  it("keeps an item's indented continuation and stops at the verdict block", () => {
    const text = "Intro prose.\n\n1. First item\n   with more at a.ts:3\n\n   and an indented paragraph.\n2. Second item\nVerdict: FIX_FIRST\n- not an item";

    expect(blockingItems(text)).toEqual(["1. First item\n   with more at a.ts:3\n   and an indented paragraph.", "2. Second item"]);
  });
});
