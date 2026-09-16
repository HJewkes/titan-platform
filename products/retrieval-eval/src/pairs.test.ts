import { describe, expect, it } from "vitest";
import { formatPairs, labelKeys, parsePairs, scopePair, type EvalPair } from "./pairs.js";

const PAIR: EvalPair = {
  arm: "spawn",
  id: "spawn:a:b",
  query: "q",
  labels: [
    { absolute: "/w/a.md", relative: "p/sources/notes/a.md", ref: "note:p/a.md" },
    { absolute: "/repo/src/index.ts" },
  ],
  provenance: { initiative: "p" },
};

describe("labelKeys", () => {
  it("offers every vocabulary a label has", () => {
    expect(labelKeys(PAIR.labels[0]!)).toEqual(["/w/a.md", "p/sources/notes/a.md", "note:p/a.md"]);
  });

  it("offers only the absolute path when that is all there is", () => {
    expect(labelKeys(PAIR.labels[1]!)).toEqual(["/repo/src/index.ts"]);
  });
});

describe("scopePair", () => {
  it("returns the pair untouched for the all scope", () => {
    expect(scopePair(PAIR, "all")).toBe(PAIR);
  });

  it("keeps only labels a workspace retriever could return", () => {
    const scoped = scopePair(PAIR, "workspace")!;
    expect(scoped.labels).toHaveLength(1);
    expect(scoped.labels[0]!.ref).toBe("note:p/a.md");
  });

  it("drops a pair whose labels are all repository files", () => {
    const repoOnly = { ...PAIR, labels: [{ absolute: "/repo/src/index.ts" }] };
    expect(scopePair(repoOnly, "workspace")).toBeUndefined();
  });

  it("does not mutate the pair it narrows", () => {
    scopePair(PAIR, "workspace");
    expect(PAIR.labels).toHaveLength(2);
  });
});

describe("parsePairs and formatPairs", () => {
  it("round-trip through JSONL", () => {
    expect(parsePairs(formatPairs([PAIR]))).toEqual([PAIR]);
  });

  it("ignores blank lines rather than failing on a trailing newline", () => {
    expect(parsePairs(`${JSON.stringify(PAIR)}\n\n`)).toHaveLength(1);
  });
});
