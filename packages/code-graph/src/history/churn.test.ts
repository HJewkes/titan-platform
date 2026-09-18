import { describe, expect, it } from "vitest";
import { aggregateChurn, aggregateChurnWindows } from "./churn.js";
import type { ChurnEntry } from "./log.js";

describe("aggregateChurn", () => {
  const entries: ChurnEntry[] = [
    { commit: "c1", author: "alice", epoch: 0, filePath: "a.ts", added: 5, deleted: 3 },
    { commit: "c2", author: "alice", epoch: 0, filePath: "a.ts", added: 1, deleted: 1 },
    { commit: "c2", author: "alice", epoch: 0, filePath: "b.ts", added: 10, deleted: 0 },
    { commit: "c3", author: "bob", epoch: 0, filePath: "a.ts", added: 2, deleted: 2 },
  ];

  it("sums added+deleted into the path's line churn", () => {
    expect(aggregateChurn(entries).get("a.ts")?.lines).toBe(5 + 3 + 1 + 1 + 2 + 2);
  });

  it("counts distinct commits per file", () => {
    expect(aggregateChurn(entries).get("a.ts")?.commits).toBe(3);
  });

  it("counts distinct authors per file", () => {
    expect(aggregateChurn(entries).get("a.ts")?.authors).toBe(2);
  });

  it("filters to known paths when provided", () => {
    expect([...aggregateChurn(entries, new Set(["a.ts"])).keys()]).toEqual(["a.ts"]);
  });

  it("emits nothing when no entries match the known set", () => {
    expect(aggregateChurn(entries, new Set(["c.ts"])).size).toBe(0);
  });
});

describe("aggregateChurnWindows", () => {
  const DAY = 86400;
  const now = 1000 * DAY;
  const mk = (filePath: string, ageDays: number, lines: number): ChurnEntry => ({
    commit: `${filePath}@${ageDays}`,
    author: "a",
    epoch: now - ageDays * DAY,
    filePath,
    added: lines,
    deleted: 0,
  });
  const entries = [mk("a.ts", 5, 3), mk("a.ts", 100, 7), mk("b.ts", 150, 4)];

  it("slices one wide log into per-window churn", () => {
    const byWindow = aggregateChurnWindows(entries, [30, 90, 180], now);
    const churn = (id: string, w: number) => byWindow.get(w)?.get(id)?.lines;
    // a.ts churned 5d ago (in all windows) and 100d ago (only 180d).
    expect(churn("a.ts", 30)).toBe(3);
    expect(churn("a.ts", 90)).toBe(3);
    expect(churn("a.ts", 180)).toBe(10);
    // b.ts only churned 150d ago, so it is absent from narrower windows.
    expect(churn("b.ts", 30)).toBeUndefined();
    expect(churn("b.ts", 180)).toBe(4);
  });

  it("aggregates ALL entries for the lifetime window regardless of age", () => {
    const lifetime = aggregateChurnWindows(entries, ["lifetime"], now).get("lifetime");
    expect(lifetime?.get("a.ts")?.lines).toBe(10);
    expect(lifetime?.get("b.ts")?.lines).toBe(4);
  });
});
