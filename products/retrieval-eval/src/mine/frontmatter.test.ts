import { describe, expect, it } from "vitest";
import { listOfMaps, readFrontmatter, scalarField } from "./frontmatter.js";

const RECORD = `---
session_id: session_01NYe7mJmonZJcH63VWPuxWF
started: '2026-09-11T10:30:00Z'
track: canonical
next_steps:
  - id: aw-phase1-next
    text: >-
      Phase 1 continues at TP-27, then TP-28 through TP-33. TP-27 owns
      the promotion machinery.
    kind: task
    ref: TP-27
  - id: search-tuning-revisit
    text: >-
      Cause: the class shares were tuned against a 573-note corpus and
      neither has a regression harness.
    kind: prose
  - id: inline
    text: One line, no block scalar.
    kind: prose
resolves:
  - ref: earlier#loop
    outcome: done
---

Body text that is not frontmatter.
`;

describe("readFrontmatter", () => {
  it("returns the block between the fences and nothing after it", () => {
    const frontmatter = readFrontmatter(RECORD);
    expect(frontmatter).toContain("session_id:");
    expect(frontmatter).not.toContain("Body text");
  });

  it("returns undefined for a file that opens with no fence", () => {
    expect(readFrontmatter("# Just a heading\n")).toBeUndefined();
  });

  it("returns undefined when the block is never closed", () => {
    expect(readFrontmatter("---\nsession_id: abc\n")).toBeUndefined();
  });
});

describe("scalarField", () => {
  it("reads a bare scalar", () => {
    expect(scalarField(readFrontmatter(RECORD)!, "track")).toBe("canonical");
  });

  it("strips the quotes a timestamp is written with", () => {
    expect(scalarField(readFrontmatter(RECORD)!, "started")).toBe("2026-09-11T10:30:00Z");
  });

  it("returns undefined for a key that is absent", () => {
    expect(scalarField(readFrontmatter(RECORD)!, "ended")).toBeUndefined();
  });
});

describe("listOfMaps", () => {
  const entries = listOfMaps(readFrontmatter(RECORD)!, "next_steps");

  it("reads every list item", () => {
    expect(entries).toHaveLength(3);
    expect(entries.map((entry) => entry.id)).toEqual(["aw-phase1-next", "search-tuning-revisit", "inline"]);
  });

  it("folds a block scalar into one line", () => {
    expect(entries[0]!.text).toBe("Phase 1 continues at TP-27, then TP-28 through TP-33. TP-27 owns the promotion machinery.");
  });

  it("keeps a colon inside block prose instead of reading it as a new field", () => {
    expect(entries[1]!.text).toContain("Cause: the class shares were tuned");
    expect(entries[1]).not.toHaveProperty("Cause");
  });

  it("does not swallow the field that follows a block scalar", () => {
    expect(entries[0]!.kind).toBe("task");
    expect(entries[0]!.ref).toBe("TP-27");
  });

  it("reads an inline value with no block marker", () => {
    expect(entries[2]!.text).toBe("One line, no block scalar.");
  });

  it("stops at the next top-level key", () => {
    expect(entries.some((entry) => entry.outcome !== undefined)).toBe(false);
  });

  it("returns nothing for a key that is not a list", () => {
    expect(listOfMaps(readFrontmatter(RECORD)!, "missing")).toEqual([]);
  });
});
