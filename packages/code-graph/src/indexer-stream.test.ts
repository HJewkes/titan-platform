import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseFile } from "@titan-design/code-parser";
import { Parser, Tree } from "web-tree-sitter";
import { assembleIndexerMetrics } from "./index-metrics.js";
import { readSnapshot, runIndex, type Snapshot } from "./incremental.test-helpers.js";
import { openCodeGraph, type CodeGraphStore } from "./store.js";

const trees = { live: 0, peak: 0 };

// Count trees at web-tree-sitter itself, below code-parser, so the indexer runs unmodified.
function countLiveTrees(): void {
  const parse = Parser.prototype.parse;
  vi.spyOn(Parser.prototype, "parse").mockImplementation(function (this: Parser, ...args) {
    const tree = parse.apply(this, args);
    if (tree) trees.peak = Math.max(trees.peak, ++trees.live);
    return tree;
  });
  const free = Tree.prototype.delete;
  vi.spyOn(Tree.prototype, "delete").mockImplementation(function (this: Tree) {
    trees.live -= 1;
    free.call(this);
  });
}

const FILE_COUNT = 20;

function moduleSource(i: number): string {
  const imports = i > 0 ? `import { f${i - 1} } from "./m${i - 1}.js";\n` : "";
  const call = i > 0 ? `f${i - 1}(n - 1)` : "0";
  return `${imports}
export function f${i}(n: number): number {
  if (n > ${i}) {
    for (let k = 0; k < n; k++) if (k % 2 === 0) return ${call};
  }
  return n;
}

export class C${i} {
  private v = 0;
  inc(): void {
    this.v += 1;
  }
}
`;
}

interface Fixture {
  rootDir: string;
  store: CodeGraphStore;
}

async function createFixture(): Promise<Fixture> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "code-graph-stream-"));
  await fs.mkdir(path.join(rootDir, "src"));
  for (let i = 0; i < FILE_COUNT; i++) {
    await fs.writeFile(path.join(rootDir, "src", `m${i}.ts`), moduleSource(i));
  }
  return { rootDir, store: openCodeGraph(path.join(rootDir, ".codewatch", "graph.db")) };
}

interface FullSnapshot extends Snapshot {
  aliases: string[];
  fingerprints: string[];
}

function readFull(store: CodeGraphStore, snapshotId: number): FullSnapshot {
  return {
    ...readSnapshot(store, snapshotId),
    aliases: store.listAliases(snapshotId).map((a) => JSON.stringify(a)).sort(),
    fingerprints: store.listFingerprints(snapshotId).map((f) => JSON.stringify(f)).sort(),
  };
}

/** A from-scratch index into a throwaway store, read back before the store closes. */
async function referenceIndex<T>(rootDir: string, read: (store: CodeGraphStore, id: number) => T): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "code-graph-stream-ref-"));
  const store = openCodeGraph(path.join(dir, "graph.db"));
  try {
    const { snapshotId } = await runIndex(store, rootDir, { incremental: false });
    return read(store, snapshotId);
  } finally {
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** The metrics the pre-TP-747 path computed: every file parsed and held, then measured from the final graph. */
async function metricsFromParsedFiles(store: CodeGraphStore, snapshotId: number, rootDir: string): Promise<string[]> {
  const nodes = store.listNodes(snapshotId, { includeSymbols: true });
  const edges = store.listEdges(snapshotId, { includeReferences: true });
  const files = await Promise.all(
    nodes
      .filter((n) => n.kind === "file")
      .map(async (n) => {
        const abs = path.join(rootDir, n.id);
        return parseFile(await fs.readFile(abs, "utf8"), abs, "typescript");
      }),
  );
  const { metrics } = assembleIndexerMetrics({
    nodes: new Map(nodes.map((n) => [n.id, n])),
    edges: new Map(edges.map((e) => [`${e.srcId}|${e.kind}|${e.dstId}`, e])),
    parsedFiles: files,
    reusedSourceMetrics: [],
    idRoot: rootDir,
  });
  for (const file of files) file.tree.delete();
  return metrics.map((m) => JSON.stringify({ nodeId: m.nodeId, name: m.name, value: m.value, unit: m.unit ?? null })).sort();
}

describe("indexPaths streams one syntax tree at a time (TP-747)", () => {
  let fixture: Fixture;
  const src = (name: string) => path.join(fixture.rootDir, "src", name);

  beforeEach(async () => {
    fixture = await createFixture();
    trees.live = 0;
    trees.peak = 0;
    countLiveTrees();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    fixture.store.close();
    await fs.rm(fixture.rootDir, { recursive: true, force: true });
  });

  it("keeps at most one tree alive and deletes every tree it parses", async () => {
    const result = await runIndex(fixture.store, fixture.rootDir, { incremental: false });

    expect(result.reparsed).toBe(FILE_COUNT);
    expect(trees.peak).toBe(1);
    expect(trees.live).toBe(0);
  });

  it("writes the metrics the parsed-files path computes from the same graph", async () => {
    const { snapshotId } = await runIndex(fixture.store, fixture.rootDir, { incremental: false });

    const stored = readSnapshot(fixture.store, snapshotId).metrics;
    const expected = await metricsFromParsedFiles(fixture.store, snapshotId, fixture.rootDir);
    expect(expected.length).toBeGreaterThan(FILE_COUNT);
    expect(stored).toEqual(expected);
  });

  it("matches a from-scratch index after one cosmetic and one structural change", async () => {
    await runIndex(fixture.store, fixture.rootDir);
    await fs.writeFile(src("m3.ts"), `// a moved comment\n\n${moduleSource(3)}`);
    await fs.writeFile(src("m7.ts"), moduleSource(7).replace("return n;", "return n * 2;"));
    trees.peak = 0;

    const incremental = await runIndex(fixture.store, fixture.rootDir);

    // m8 imports the structurally changed m7, so it re-extracts too (TP-3636); m4 stays reused past m3's cosmetic edit.
    expect(incremental.reparsed).toBe(3);
    expect(incremental.cosmetic).toBe(1);
    expect(trees.peak).toBe(1);
    expect(trees.live).toBe(0);
    expect(readFull(fixture.store, incremental.snapshotId)).toEqual(await referenceIndex(fixture.rootDir, readFull));
  });

});
