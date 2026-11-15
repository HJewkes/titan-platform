import { describe, expect, it } from "vitest";
import { checkIndex, INDEX_LOAD_LINE_LIMIT } from "./index-check.js";

const pointer = (file: string): string => `- [Title](${file}) — hook`;

describe("checkIndex", () => {
  it("reports nothing for an index that names every fact file", () => {
    const raw = [pointer("a.md"), pointer("b.md")].join("\n");

    expect(checkIndex(raw, ["a.md", "b.md", "MEMORY.md"])).toEqual({ dangling: [], unindexed: [], unloaded: [] });
  });

  it("reports a pointer to a file that is not in the directory", () => {
    const raw = [pointer("a.md"), pointer("gone.md")].join("\n");

    expect(checkIndex(raw, ["a.md"]).dangling).toEqual([{ file: "gone.md", line: 2 }]);
  });

  it("reports a fact file that no pointer names", () => {
    expect(checkIndex(pointer("a.md"), ["a.md", "orphan.md"]).unindexed).toEqual(["orphan.md"]);
  });

  it("reports a pointer on the line after the load limit as unloaded", () => {
    const filler = Array.from({ length: INDEX_LOAD_LINE_LIMIT }, () => "prose");
    filler[INDEX_LOAD_LINE_LIMIT - 1] = pointer("a.md");
    const raw = [...filler, pointer("late.md")].join("\n");

    expect(checkIndex(raw, ["a.md", "late.md"])).toEqual({ dangling: [], unindexed: [], unloaded: [{ file: "late.md", line: INDEX_LOAD_LINE_LIMIT + 1 }] });
  });

  it("ignores prose lines", () => {
    const raw = ["# Memory", "Notes the harness wrote.", pointer("a.md")].join("\n");

    expect(checkIndex(raw, ["a.md"])).toEqual({ dangling: [], unindexed: [], unloaded: [] });
  });
});
