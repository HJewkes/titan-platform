import { describe, expect, it } from "vitest";
import { mutateQuery, mutateTerm, MUTATIONS } from "./mutate.js";

describe("mutateTerm", () => {
  it("drops exactly one letter", () => {
    const out = mutateTerm("retrieval", "drop-letter", "pair-1");
    expect(out).toHaveLength("retrieval".length - 1);
    expect(isSubsequence(out, "retrieval")).toBe(true);
  });

  it("swaps one adjacent pair and keeps the letters", () => {
    const out = mutateTerm("retrieval", "swap-pair", "pair-1");
    expect(out).not.toBe("retrieval");
    expect([...out].sort()).toEqual([..."retrieval"].sort());
    expect(diffPositions(out, "retrieval")).toHaveLength(2);
  });

  it("keeps a mid-token substring that excludes both ends", () => {
    const out = mutateTerm("retrieval", "substring", "pair-1");
    expect(out.length).toBeLessThan("retrieval".length);
    expect("retrieval".slice(1, -1)).toContain(out);
  });

  it("gives expected strings for a fixed term and seed", () => {
    expect(MUTATIONS.map((m) => mutateTerm("recall", m, "fixed"))).toEqual(["recall", "recal", "rceall", "eca"]);
  });

  it("gives the same mutation for the same pair id every time", () => {
    for (const mutation of MUTATIONS) {
      expect(mutateTerm("retrieval", mutation, "pair-9")).toBe(mutateTerm("retrieval", mutation, "pair-9"));
    }
  });
});

describe("mutateQuery", () => {
  const df = new Map([
    ["notes", 9],
    ["zebra", 1],
  ]);

  it("mutates the rarest term only", () => {
    const out = mutateQuery("notes zebra", df, "drop-letter", "p");
    expect(out.skipped).toBe(false);
    expect(out.query.startsWith("notes ")).toBe(true);
    expect(out.query).not.toBe("notes zebra");
  });

  it("leaves a term under 4 characters unchanged and counts it skipped", () => {
    expect(mutateQuery("cat", new Map(), "drop-letter", "p")).toEqual({ query: "cat", skipped: true });
  });

  it("never touches the query for none", () => {
    expect(mutateQuery("notes zebra", df, "none", "p")).toEqual({ query: "notes zebra", skipped: false });
  });
});

function isSubsequence(small: string, big: string): boolean {
  let i = 0;
  for (const ch of big) if (ch === small[i]) i++;
  return i === small.length;
}

function diffPositions(a: string, b: string): number[] {
  return [...a].flatMap((ch, i) => (ch === b[i] ? [] : [i]));
}
