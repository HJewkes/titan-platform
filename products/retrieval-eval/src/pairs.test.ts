import { afterEach, describe, expect, it, vi } from "vitest";
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

describe("parsePairs over a damaged file", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function jsonlWith(badLine: string): string {
    return [JSON.stringify(PAIR), badLine, JSON.stringify({ ...PAIR, id: "spawn:c:d" })].join("\n");
  }

  function captureErrors(): () => string[] {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    return () => spy.mock.calls.map((call) => String(call[0]));
  }

  it("a wrong-shaped line is skipped and logged", () => {
    const errors = captureErrors();

    const pairs = parsePairs(jsonlWith(JSON.stringify({ ...PAIR, labels: "not-a-list" })));

    expect(pairs.map((pair) => pair.id)).toEqual(["spawn:a:b", "spawn:c:d"]);
    expect(errors()).toEqual(["parsePairs: skipped 1 of 3 pair lines (bad lines: 2)"]);
  });

  it("a truncated line is skipped and logged", () => {
    const errors = captureErrors();

    const pairs = parsePairs(jsonlWith(JSON.stringify(PAIR).slice(0, 20)));

    expect(pairs.map((pair) => pair.id)).toEqual(["spawn:a:b", "spawn:c:d"]);
    expect(errors()).toEqual(["parsePairs: skipped 1 of 3 pair lines (bad lines: 2)"]);
  });

  it("a file whose every line is bad is refused", () => {
    const jsonl = [JSON.stringify(PAIR).slice(0, 20), JSON.stringify({ ...PAIR, labels: "not-a-list" })].join("\n");

    expect(() => parsePairs(jsonl)).toThrow("parsePairs: no valid pairs: skipped 2 of 2 pair lines (bad lines: 1, 2)");
  });

  it("an empty file is not a damaged one and still reads as no pairs", () => {
    const errors = captureErrors();

    expect(parsePairs("\n")).toEqual([]);
    expect(errors()).toEqual([]);
  });

  it("logs nothing for a clean file", () => {
    const errors = captureErrors();

    parsePairs(formatPairs([PAIR]));

    expect(errors()).toEqual([]);
  });

  it("unknown keys survive a parse", () => {
    const withExtras = {
      ...PAIR,
      minerVersion: 2,
      labels: [{ absolute: "/w/a.md", weight: 0.5 }],
      provenance: { initiative: "p", linkScore: 0.9 },
    };

    expect(parsePairs(JSON.stringify(withExtras))).toEqual([withExtras]);
  });
});
