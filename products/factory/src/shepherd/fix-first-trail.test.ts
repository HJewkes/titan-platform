import { fakeSha } from "@titan-design/github";
import { describe, expect, it } from "vitest";
import { defectClassKey, fixFirstEntry, sameClassAsEarlier } from "./fix-first-trail.js";

const H1 = fakeSha("trail-1");
const H2 = fakeSha("trail-2");
const H3 = fakeSha("trail-3");
const withClass = (head: string, line: string) => fixFirstEntry(head, `1. A blocking item.\n\n${line}\n\nVerdict: FIX_FIRST\nPR: octo/demo#7\nHead: ${head}`);

describe("defectClassKey", () => {
  it("reads two spellings of one class as one key, whatever their case, punctuation or spacing", () => {
    expect(defectClassKey("Defect class: Unquoted shell words.")).toBe("unquoted shell words");
    expect(defectClassKey("defect class:  unquoted shell words")).toBe("unquoted shell words");
    expect(defectClassKey("## **Defect class:** Unquoted   shell words!")).toBe("unquoted shell words");
  });

  it("is undefined when the findings name no class, or a heading with nothing after it", () => {
    expect(defectClassKey("1. The parser drops the last token.")).toBeUndefined();
    expect(defectClassKey("Defect class:\n\nVerdict: FIX_FIRST")).toBeUndefined();
  });
});

describe("sameClassAsEarlier", () => {
  const unquoted = withClass(H1, "Defect class: unquoted shell words.");
  const failOpen = withClass(H2, "Defect class: fail-open defaults.");

  it("matches a class any earlier round named, not only the last", () => {
    expect(sameClassAsEarlier([unquoted, failOpen], withClass(H3, "Defect class: Unquoted shell words"))).toBe(true);
  });

  it("does not match a new class", () => {
    expect(sameClassAsEarlier([unquoted, failOpen], withClass(H3, "Defect class: stale cache reads."))).toBe(false);
  });

  it("does not match when the current review names no class, even after earlier rounds that named none", () => {
    const unnamed = fixFirstEntry(H3, "1. A blocking item.");

    expect(sameClassAsEarlier([unquoted, fixFirstEntry(H2, "1. Another item.")], unnamed)).toBe(false);
  });
});

describe("fixFirstEntry", () => {
  it("keeps the reviewer's class section without the verdict block, and omits the class when there is none", () => {
    expect(withClass(H1, "Defect class: unquoted shell words.")).toMatchObject({ headSha: H1, defectClass: "Defect class: unquoted shell words." });
    expect(fixFirstEntry(H1, "1. A blocking item.")).toEqual({ headSha: H1, text: "1. A blocking item." });
  });
});
