import type { ChangedFile } from "@titan-design/review-panel";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFixtureGraph, insertOrigin, insertPrices, insertRequest, type FixtureGraph } from "./fixture.js";
import { listMergedPrRefs, parsePrRef, prFeaturesFor, type PrDiff } from "./task-actuals-pr.js";
import { taskActuals, type ActualsTask } from "./task-actuals.js";

let fixture: FixtureGraph;

beforeEach(() => {
  fixture = createFixtureGraph();
  insertPrices(fixture.graph);
});
afterEach(() => fixture.close());

const OPTIONS = { initiatives: ["alpha"] };
const MERGED = "2026-09-20T11:00:00Z";
const PR1 = "pr:o/r#1";
const PR2 = "pr:o/r#2";

function task(id: string, kind?: string): ActualsTask {
  return { id, initiative: "alpha", doneAt: "2026-09-20T12:00:00Z", ...(kind !== undefined && { kind }) };
}

function file(path: string, lines: number): ChangedFile {
  return { path, additions: lines, deletions: 0 };
}

function diff(prRef: string, files: ChangedFile[], truncated = false): PrDiff {
  const parsed = parsePrRef(prRef)!;
  return { prRef, ...parsed, head: `head-${parsed.pr}`, files, truncated };
}

const cache = (...diffs: PrDiff[]) => new Map(diffs.map((d) => [d.prRef, d]));
const merged = (...refs: string[]) => ({ prs: refs.map((prRef) => ({ prRef, mergedAt: MERGED })) });

function implementerWithPrs(sessionId: string, taskId: string, prs: Record<string, string | null>): void {
  const db = fixture.graph.db;
  insertOrigin(db, { sessionId, depth: 1, profile: "implementer" });
  db.prepare("UPDATE session_origin SET task_ids = ?, task_source = 'name' WHERE session_id = ?").run(JSON.stringify([taskId]), sessionId);
  insertRequest(db, { sessionId, ts: "2026-09-20T09:00:00.000Z", outputTokens: 1000, gapMs: null });
  for (const [prRef, mergedAt] of Object.entries(prs)) {
    db.prepare("INSERT OR IGNORE INTO pr (pr_ref, merged_at) VALUES (?, ?)").run(prRef, mergedAt);
    fixture.graph.edges.assert({ sourceRef: `session:${sessionId}`, relation: "linked", targetRef: prRef });
  }
}

describe("prFeaturesFor", () => {
  const migration = diff(PR1, [file("packages/store/migration/0001.sql", 250)]);
  const notes = diff(PR2, [file("docs/notes.md", 200)]);

  it("classifies a task's PRs as one change, so two medium PRs together are large", () => {
    const features = prFeaturesFor(merged(PR1, PR2), "product", cache(migration, notes));

    expect(features).toEqual({ prClass: "g10", touches: ["migration", "large"], changedLines: 450, missing: false });
  });

  it("classifies an absent kind strict even when the diff is small", () => {
    const features = prFeaturesFor(merged(PR2), undefined, cache(diff(PR2, [file("docs/notes.md", 5)])));

    expect(features.prClass).toBe("g10");
    expect(features.touches).toEqual([]);
  });

  it("leaves generated lines out of the size of a docs change", () => {
    const docs = diff(PR1, [file("site/guides/howto.md", 30), file("site/reference/pkg.md", 300)]);

    const features = prFeaturesFor(merged(PR1), "docs", cache(docs));

    expect(features).toEqual({ prClass: "standard", touches: [], changedLines: 30, missing: false });
  });

  it("gives nulls and reports missing when one merged PR has no cache entry", () => {
    expect(prFeaturesFor(merged(PR1, PR2), "product", cache(migration))).toEqual({ prClass: null, touches: null, changedLines: null, missing: true });
  });

  it("gives the no-PR shape when the task merged no PR", () => {
    const unmerged = { prs: [{ prRef: PR1, mergedAt: null }] };

    expect(prFeaturesFor(unmerged, "product", cache())).toEqual({ prClass: null, touches: [], changedLines: 0, missing: false });
  });

  it("reads a truncated file list as large with no line count", () => {
    const many = Array.from({ length: 20 }, (_, i) => file(`docs/page-${i}.md`, 1));

    const features = prFeaturesFor(merged(PR1), "docs", cache(diff(PR1, many, true)));

    expect(features).toEqual({ prClass: "g10", touches: ["large"], changedLines: null, missing: false });
  });
});

describe("taskActuals with prDiffs", () => {
  it("adds the features to a row and flags a merged PR the cache lacks", () => {
    implementerWithPrs("s1", "T-1", { [PR1]: MERGED });
    implementerWithPrs("s2", "T-2", { [PR2]: MERGED });
    const diffs = cache(diff(PR1, [file("docs/notes.md", 10)]));

    const [found, absent] = taskActuals(fixture.openReadOnly(), [task("T-1", "docs"), task("T-2", "docs")], { ...OPTIONS, prDiffs: diffs });

    expect(found).toMatchObject({ prClass: "standard", touches: [], changedLines: 10, flags: [] });
    expect(absent).toMatchObject({ prClass: null, touches: null, changedLines: null, flags: ["pr-diff-missing"] });
  });

  it("leaves rows without feature keys when no cache is passed", () => {
    implementerWithPrs("s1", "T-1", { [PR1]: MERGED });

    const [row] = taskActuals(fixture.openReadOnly(), [task("T-1", "docs")], OPTIONS);

    expect(row).not.toHaveProperty("prClass");
    expect(row).not.toHaveProperty("touches");
    expect(row).not.toHaveProperty("changedLines");
  });
});

describe("listMergedPrRefs", () => {
  it("returns only merged refs, sorted, from the since date on", () => {
    implementerWithPrs("s1", "T-1", { "pr:o/r#9": "2026-09-01T00:00:00Z", "pr:o/r#3": "2026-09-10T00:00:00Z", "pr:o/r#5": null, "pr:a/b#1": "2026-09-15T00:00:00Z" });
    const db = fixture.openReadOnly();

    expect(listMergedPrRefs(db)).toEqual(["pr:a/b#1", "pr:o/r#3", "pr:o/r#9"]);
    expect(listMergedPrRefs(db, "2026-09-10")).toEqual(["pr:a/b#1", "pr:o/r#3"]);
  });
});

describe("parsePrRef", () => {
  it("reads the repo and number back out of a miner PR ref", () => {
    expect(parsePrRef("pr:HJewkes/titan-platform#1130")).toEqual({ repo: "HJewkes/titan-platform", pr: 1130 });
    expect(parsePrRef("branch:o/r:main")).toBeUndefined();
  });
});
