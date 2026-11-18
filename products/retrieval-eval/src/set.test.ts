import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatPairs, type EvalPair } from "./pairs.js";
import { freezeSet, loadSet } from "./set.js";
import type { CorpusSnapshot } from "./snapshot.js";

const SNAPSHOT: CorpusSnapshot = {
  takenAt: "2026-01-01T00:00:00.000Z",
  transcripts: 0,
  transcriptRange: {},
  graph: { path: "/fixture/graph.sqlite3", bytes: 0, modified: "2026-01-01T00:00:00.000Z" },
  activeWorkVersion: "unavailable",
};

function pair(id: string, arm: EvalPair["arm"] = "spawn"): EvalPair {
  return { arm, id, query: `query ${id}`, labels: [{ absolute: `/x/${id}.md` }], provenance: {} };
}

describe("frozen pair sets", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "retrieval-set-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("gives the same id when the same pairs arrive in another order", () => {
    const pairs = [pair("a"), pair("b", "bootstrap"), pair("c")];
    const first = freezeSet(formatPairs(pairs), path.join(root, "one"), SNAPSHOT);
    const second = freezeSet(formatPairs([...pairs].reverse()), path.join(root, "two"), SNAPSHOT);
    expect(second.id).toBe(first.id);
    expect(first.id).toMatch(/^[0-9a-f]{12}$/);
    expect(first.pairCounts).toEqual({ spawn: 2, bootstrap: 1 });
  });

  it("writes a duplicate id once", () => {
    const dir = path.join(root, "dup");
    freezeSet(formatPairs([pair("a"), pair("a"), pair("b")]), dir, SNAPSHOT);
    const lines = readFileSync(path.join(dir, "pairs.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(loadSet(dir).stamp).toMatchObject({ pairs: 2 });
  });

  it("refuses a set whose pairs were edited by one byte", () => {
    const dir = path.join(root, "edit");
    freezeSet(formatPairs([pair("a"), pair("b")]), dir, SNAPSHOT);
    const file = path.join(dir, "pairs.jsonl");
    writeFileSync(file, readFileSync(file, "utf8").replace("query a", "query A"));
    expect(() => loadSet(dir)).toThrow(/does not match manifest id/);
  });
});
