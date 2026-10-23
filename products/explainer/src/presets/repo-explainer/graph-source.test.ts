import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { indexPaths, openCodeGraph } from "@titan-design/code-graph";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { openStructureGraph, REVIEW_GRAPH_DB, type GraphSourceOptions, type StructureGraph } from "./graph-source.js";
import { fixtureClone, FIXTURE_PIN, OTHER_PIN } from "./test-support/structure-fixture.js";

const temps: string[] = [];
const graphs: StructureGraph[] = [];
let clone: string;
let reviewedDb: string;

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

async function reviewWith(db: string | undefined): Promise<string> {
  const reviewDir = await tempDir("rx-review-");
  if (db === undefined) return reviewDir;
  await mkdir(join(reviewDir, "structural"), { recursive: true });
  await copyFile(db, join(reviewDir, REVIEW_GRAPH_DB));
  return reviewDir;
}

async function open(overrides: Partial<GraphSourceOptions>) {
  const result = await openStructureGraph({ reviewDir: await reviewWith(undefined), clonePath: clone, pin: FIXTURE_PIN, ...overrides });
  if (result.ok) graphs.push(result.graph);
  return result;
}

beforeAll(async () => {
  clone = await fixtureClone();
  temps.push(clone);
  reviewedDb = join(await tempDir("rx-reviewed-"), "graph.db");
  const store = openCodeGraph(reviewedDb);
  await indexPaths(store, { paths: [clone], commitHash: FIXTURE_PIN, computeMetrics: false, computeChurn: false });
  store.close();
});

afterEach(async () => {
  await Promise.all(graphs.splice(0).map((graph) => graph.close()));
});

afterAll(async () => {
  await Promise.all(temps.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("openStructureGraph", () => {
  it("indexes the clone fresh at the pin when the review has no index", async () => {
    const result = await open({});

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.graph).toMatchObject({ source: "fresh-index", files: 4 });
    expect(result.graph.store.getSnapshot(result.graph.snapshotId)?.commitHash).toBe(FIXTURE_PIN);
    expect(result.diagnostics).toEqual([]);
  });

  it("reuses a review index that holds a snapshot at the pin without indexing", async () => {
    const index = vi.fn(indexPaths);

    const result = await open({ reviewDir: await reviewWith(reviewedDb), index });

    expect(result.ok && result.graph.source).toBe("review-index");
    expect(index).not.toHaveBeenCalled();
  });

  it("reads a pinned snapshot that is still only in the review db's write-ahead log", async () => {
    const live = join(await tempDir("rx-live-"), "graph.db");
    const store = openCodeGraph(live);
    await indexPaths(store, { paths: [clone], commitHash: FIXTURE_PIN, computeMetrics: false, computeChurn: false });
    const reviewDir = await reviewWith(live);
    await copyFile(`${live}-wal`, join(reviewDir, `${REVIEW_GRAPH_DB}-wal`));
    store.close();

    const result = await open({ reviewDir, index: vi.fn(indexPaths) });

    expect(result.ok && result.graph.source).toBe("review-index");
    expect(result.diagnostics).toEqual([]);
  });

  it("re-indexes with W-INDEX-PIN when the review index was taken at another commit", async () => {
    const index = vi.fn(indexPaths);

    const result = await open({ reviewDir: await reviewWith(reviewedDb), pin: OTHER_PIN, index });

    expect(result.ok && result.graph.source).toBe("fresh-index");
    expect(index).toHaveBeenCalledOnce();
    expect(result.diagnostics.map((finding) => finding.code)).toEqual(["W-INDEX-PIN"]);
  });

  it("refuses with E-INDEX when the index fails", async () => {
    const index = vi.fn(async () => {
      throw new Error("parser crashed");
    });

    const result = await open({ index });

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toEqual([expect.objectContaining({ code: "E-INDEX", severity: "error" })]);
    expect(result.diagnostics[0]!.message).toContain("parser crashed");
  });

  it("returns the graph with W-NO-INDEX when the clone has no source files", async () => {
    const empty = await tempDir("rx-empty-");

    const result = await open({ clonePath: empty });

    expect(result.ok && result.graph.files).toBe(0);
    expect(result.diagnostics.map((finding) => finding.code)).toEqual(["W-NO-INDEX"]);
  });

  it("reuses a cached fresh index at the pin on the second run", async () => {
    const cacheDir = await tempDir("rx-cache-");
    const first = await open({ cacheDir });
    if (first.ok) await first.graph.close();
    graphs.length = 0;
    const index = vi.fn(indexPaths);

    const second = await open({ cacheDir, index });

    expect(second.ok && second.graph.files).toBe(4);
    expect(index).not.toHaveBeenCalled();
  });
});
