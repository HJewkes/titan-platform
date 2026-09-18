import { describe, expect, it } from "vitest";
import { computeOwnership } from "./ownership.js";
import type { ChurnEntry } from "./log.js";

function entry(commit: string, author: string, filePath: string, lines: number): ChurnEntry {
  return { commit, author, epoch: 0, filePath, added: lines, deleted: 0 };
}

describe("computeOwnership", () => {
  it("gives a single-author file bus factor 1 and top-author share 1", () => {
    const owner = computeOwnership([entry("c1", "alice", "a.ts", 10), entry("c2", "alice", "a.ts", 20)]).get("a.ts");
    expect(owner).toEqual({ authors: 1, topAuthorShare: 1, busFactor: 1 });
  });

  it("needs two authors when none clears 50% (40/40/20 over full history)", () => {
    const owner = computeOwnership([
      entry("c1", "alice", "a.ts", 40),
      entry("c2", "bob", "a.ts", 40),
      entry("c3", "carol", "a.ts", 20),
    ]).get("a.ts");
    expect(owner?.busFactor).toBe(2);
    expect(owner?.topAuthorShare).toBe(0.4);
  });

  it("computes bus factor at the 50% threshold by default", () => {
    // alice alone holds 60 of 100 lines, which clears 50%.
    const owner = computeOwnership([
      entry("c1", "alice", "a.ts", 60),
      entry("c2", "bob", "a.ts", 30),
      entry("c3", "carol", "a.ts", 10),
    ]).get("a.ts");
    expect(owner?.busFactor).toBe(1);
    expect(owner?.topAuthorShare).toBe(0.6);
  });

  it("requires two authors when the top author is under 50%", () => {
    const owner = computeOwnership([
      entry("c1", "alice", "a.ts", 40),
      entry("c2", "bob", "a.ts", 30),
      entry("c3", "carol", "a.ts", 30),
    ]).get("a.ts");
    expect(owner?.busFactor).toBe(2);
    expect(owner?.topAuthorShare).toBe(0.4);
  });

  it("counts an author who reaches the threshold exactly (50/50 gives bus factor 1)", () => {
    const owner = computeOwnership([entry("c1", "alice", "a.ts", 40), entry("c2", "bob", "a.ts", 40)]).get("a.ts");
    expect(owner?.topAuthorShare).toBe(0.5);
    expect(owner?.busFactor).toBe(1);
  });

  it("respects busFactorThreshold (e.g. 80%)", () => {
    const owner = computeOwnership(
      [entry("c1", "alice", "a.ts", 60), entry("c2", "bob", "a.ts", 30), entry("c3", "carol", "a.ts", 10)],
      { busFactorThreshold: 0.8 },
    ).get("a.ts");
    expect(owner?.busFactor).toBe(2);
  });

  it("filters by knownPaths", () => {
    const owners = computeOwnership(
      [entry("c1", "alice", "a.ts", 10), entry("c2", "alice", "untracked.ts", 10)],
      { knownPaths: new Set(["a.ts"]) },
    );
    expect([...owners.keys()]).toEqual(["a.ts"]);
  });

  it("skips files with zero total churn", () => {
    expect(computeOwnership([entry("c1", "alice", "a.ts", 0)]).size).toBe(0);
  });

  it("counts unique author identities by email for bus factor", () => {
    // The author field holds git's %ae, which stays stable while display names drift.
    const entries: ChurnEntry[] = [
      ...Array.from({ length: 5 }, (_, i) => entry(`a${i}`, "alice@example.com", "f.ts", 10)),
      ...Array.from({ length: 2 }, (_, i) => entry(`b${i}`, "bob@example.com", "f.ts", 10)),
    ];
    const owner = computeOwnership(entries, { busFactorThreshold: 0.99 }).get("f.ts");
    expect(owner?.authors).toBe(2);
    expect(owner?.busFactor).toBe(2);
  });
});
