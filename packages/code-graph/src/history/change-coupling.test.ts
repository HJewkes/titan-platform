import { describe, expect, it } from "vitest";
import { computeChangeCoupling, couplingFor } from "./change-coupling.js";
import type { ChurnEntry } from "./log.js";

function entry(commit: string, filePath: string): ChurnEntry {
  return { commit, author: "alice", epoch: 0, filePath, added: 1, deleted: 0 };
}

const commitOf = (commit: string, files: readonly string[]) => files.map((f) => entry(commit, f));

describe("computeChangeCoupling", () => {
  it("returns no pairs when no commits touch >=2 files", () => {
    const { pairs, skippedLargeCommits } = computeChangeCoupling([entry("c1", "a.ts"), entry("c2", "b.ts")]);
    expect(pairs).toEqual([]);
    expect(skippedLargeCommits).toBe(0);
  });

  it("counts each commit that touched both files in a pair", () => {
    const { pairs } = computeChangeCoupling(["c1", "c2", "c3"].flatMap((c) => commitOf(c, ["a.ts", "b.ts"])));
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ fileA: "a.ts", fileB: "b.ts", count: 3 });
    expect(pairs[0]!.commits).toEqual(["c1", "c2", "c3"]);
  });

  it("dedupes per-commit file mentions", () => {
    const { pairs } = computeChangeCoupling(
      [...commitOf("c1", ["a.ts", "a.ts", "b.ts"]), ...commitOf("c2", ["a.ts", "b.ts"])],
      { minCount: 2 },
    );
    expect(pairs[0]!.count).toBe(2);
  });

  it("skips commits that touch more files than largeCommitThreshold", () => {
    const entries = [
      ...commitOf("sweep", ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"]),
      ...commitOf("c1", ["a.ts", "b.ts"]),
      ...commitOf("c2", ["a.ts", "b.ts"]),
    ];
    const { pairs } = computeChangeCoupling(entries, { largeCommitThreshold: 4 });
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ fileA: "a.ts", fileB: "b.ts", count: 2 });
    expect(pairs[0]!.commits).toEqual(["c1", "c2"]);
  });

  it("reports skippedLargeCommits count for over-threshold commits", () => {
    const five = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"];
    const entries = [
      ...commitOf("sweep1", five),
      ...commitOf("sweep2", five),
      ...commitOf("normal", ["x.ts", "y.ts", "z.ts"]),
      entry("solo", "a.ts"),
    ];
    const result = computeChangeCoupling(entries, { largeCommitThreshold: 4 });
    expect(result.skippedLargeCommits).toBe(2);
    expect(result.largeCommitThreshold).toBe(4);
  });

  it("uses the default threshold when none is provided", () => {
    const result = computeChangeCoupling(commitOf("big", Array.from({ length: 60 }, (_, i) => `file${i}.ts`)));
    expect(result.skippedLargeCommits).toBe(1);
    expect(result.largeCommitThreshold).toBe(50);
  });

  it("respects the minCount threshold", () => {
    const entries = [...commitOf("c1", ["a.ts", "b.ts"]), ...commitOf("c2", ["c.ts", "d.ts", "a.ts", "b.ts"])];
    const lowBar = computeChangeCoupling(entries, { minCount: 1 });
    const strict = computeChangeCoupling(entries, { minCount: 2 });
    expect(lowBar.pairs.length).toBeGreaterThan(strict.pairs.length);
    expect(strict.pairs.map((p) => `${p.fileA}|${p.fileB}`)).toEqual(["a.ts|b.ts"]);
  });

  it("truncates the commit sample at maxCommitsPerPair", () => {
    const entries = [1, 2, 3, 4, 5, 6].flatMap((i) => commitOf(`c${i}`, ["a.ts", "b.ts"]));
    const { pairs } = computeChangeCoupling(entries, { minCount: 2, maxCommitsPerPair: 3 });
    expect(pairs[0]!.count).toBe(6);
    expect(pairs[0]!.commits).toHaveLength(3);
  });

  it("filters by knownPaths", () => {
    const entries = [...commitOf("c1", ["a.ts", "b.ts", "untracked.ts"]), ...commitOf("c2", ["a.ts", "b.ts"])];
    const { pairs } = computeChangeCoupling(entries, { knownPaths: new Set(["a.ts", "b.ts"]) });
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ fileA: "a.ts", fileB: "b.ts" });
  });

  it("sorts pairs by count desc, paths ascending on ties", () => {
    const entries = [
      ...commitOf("c1", ["a.ts", "b.ts"]),
      ...commitOf("c2", ["a.ts", "b.ts"]),
      ...commitOf("c3", ["c.ts", "d.ts"]),
      ...commitOf("c4", ["c.ts", "d.ts"]),
      entry("c5", "x.ts"),
      entry("x.ts", "y.ts"),
    ];
    const { pairs } = computeChangeCoupling(entries);
    expect(pairs.slice(0, 2).map((p) => `${p.fileA}|${p.fileB}`)).toEqual(["a.ts|b.ts", "c.ts|d.ts"]);
  });
});

describe("couplingFor", () => {
  it("returns partners for a given seed sorted by count desc", () => {
    const pairs = [
      { fileA: "a.ts", fileB: "b.ts", count: 5, commits: [] },
      { fileA: "a.ts", fileB: "c.ts", count: 3, commits: [] },
      { fileA: "d.ts", fileB: "a.ts", count: 8, commits: [] },
      { fileA: "x.ts", fileB: "y.ts", count: 10, commits: [] },
    ];
    const result = couplingFor(pairs, "a.ts");
    expect(result.map((r) => r.partner)).toEqual(["d.ts", "b.ts", "c.ts"]);
    expect(result.map((r) => r.count)).toEqual([8, 5, 3]);
  });

  it("returns empty when seed appears in no pair", () => {
    expect(couplingFor([], "nope.ts")).toEqual([]);
  });
});
