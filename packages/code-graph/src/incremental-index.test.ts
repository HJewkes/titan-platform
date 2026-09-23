import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseFile } from "@titan-design/code-parser";
import { computeSourceMetrics, SOURCE_METRIC_NAMES } from "./source-metrics.js";
import {
  B_TS,
  createProject,
  disposeProject,
  fullIndexSnapshot,
  readSnapshot,
  runIndex,
  type Project,
} from "./incremental.test-helpers.js";

describe("fingerprint-based incremental indexing", () => {
  let project: Project;
  const index = (options: { incremental?: boolean } = {}) =>
    runIndex(project.store, project.rootDir, options);
  const src = (...parts: string[]): string => path.join(project.rootDir, "src", ...parts);
  const snapshot = (id: number) => readSnapshot(project.store, id);

  beforeEach(async () => {
    project = await createProject();
  });

  afterEach(async () => {
    await disposeProject(project);
  });

  it("reuses every file on a no-change re-index", async () => {
    const first = await index();
    const second = await index();

    expect(second.reused).toBe(first.files);
    expect(second.reparsed).toBe(0);
    expect(snapshot(second.snapshotId)).toEqual(snapshot(first.snapshotId));
  });

  it("carries symbol nodes and references edges forward on reuse (C-53)", async () => {
    const first = await index();
    const second = await index();
    expect(second.reparsed).toBe(0);

    const nodes = project.store.listNodes(second.snapshotId, { includeSymbols: true });
    expect(nodes.some((n) => n.kind === "symbol" && n.id === "src/a.ts#A")).toBe(true);
    const refs = project.store
      .listEdges(second.snapshotId, { includeReferences: true })
      .filter((e) => e.kind === "references");
    expect(refs.some((e) => e.srcId === "src/b.ts" && e.dstId === "src/a.ts#A")).toBe(true);
    expect(snapshot(second.snapshotId)).toEqual(snapshot(first.snapshotId));
  });

  it("produces a snapshot identical to a full index after one file changes", async () => {
    await index();
    await fs.writeFile(src("a.ts"), "export const A = 42;\nexport const A2 = A + 1;\n");

    const incremental = await index();

    expect(incremental.reparsed).toBe(1);
    expect(incremental.reused).toBe(incremental.files - 1);
    expect(snapshot(incremental.snapshotId)).toEqual(await fullIndexSnapshot(project.rootDir));
  });

  it("reuses unaffected files when a file is ADDED (C-20 partial reuse)", async () => {
    await index();
    // d.ts imports a.ts; none of a/b/c reference d, so their edges are unaffected.
    await fs.writeFile(src("d.ts"), 'import { A } from "./a.js";\nexport const D = A;\n');

    const incremental = await index();

    expect(incremental.reparsed).toBe(1);
    expect(incremental.reused).toBe(3);
    expect(snapshot(incremental.snapshotId)).toEqual(await fullIndexSnapshot(project.rootDir));
  });

  it("re-extracts a referencer when its imported target is REMOVED, reuses the rest (C-20)", async () => {
    await fs.writeFile(src("y.ts"), "export const Y = 1;\n");
    await fs.writeFile(src("x.ts"), 'import { Y } from "./y.js";\nexport const X = Y;\n');
    await index();
    await fs.rm(src("y.ts"));

    const incremental = await index();

    expect(incremental.reparsed).toBe(1);
    expect(incremental.reused).toBe(3);
    expect(snapshot(incremental.snapshotId)).toEqual(await fullIndexSnapshot(project.rootDir));
  });

  it("reuses independent files when an unreferenced file is REMOVED (C-20)", async () => {
    await fs.writeFile(src("lonely.ts"), "export const L = 1;\n");
    await index();
    await fs.rm(src("lonely.ts"));

    const incremental = await index();

    expect(incremental.reparsed).toBe(0);
    expect(incremental.reused).toBe(3);
    expect(snapshot(incremental.snapshotId)).toEqual(await fullIndexSnapshot(project.rootDir));
  });

  it("re-extracts a file when an ADDED file shadows its import resolution (C-20)", async () => {
    await fs.mkdir(src("m"), { recursive: true });
    await fs.writeFile(src("m", "index.ts"), "export const M = 1;\n");
    await fs.writeFile(src("w.ts"), 'import { M } from "./m";\nexport const W = M;\n');
    await index();
    // m.ts shadows m/index.ts for the specifier "./m" (file beats directory).
    await fs.writeFile(src("m.ts"), "export const M = 2;\n");

    const incremental = await index();

    expect(incremental.reused).toBe(4);
    expect(snapshot(incremental.snapshotId)).toEqual(await fullIndexSnapshot(project.rootDir));
  });

  it("COSMETIC change (comments/whitespace) reuses edges, skips extract, stays identical to a full index", async () => {
    await index();
    const cosmetic = `// a newly added banner comment\n${B_TS.replace(
      "return path.sep;",
      "return path.sep; // inline note",
    )}`;
    await fs.writeFile(src("b.ts"), cosmetic);

    const incremental = await index();

    expect(incremental.cosmetic).toBe(1);
    expect(incremental.reused).toBe(incremental.files - 1);
    expect(snapshot(incremental.snapshotId)).toEqual(await fullIndexSnapshot(project.rootDir));
    const classify = project.store
      .listNodes(incremental.snapshotId, { includeSymbols: true })
      .find((n) => n.kind === "symbol" && n.name === "classify");
    expect((classify?.attrs as { startLine?: number }).startLine).toBe(5);
  });

  it("a real token change is STRUCTURAL, not cosmetic (full extract)", async () => {
    await index();
    await fs.writeFile(src("b.ts"), B_TS.replace("i % 2 === 0", "i % 3 === 0"));

    const incremental = await index();

    expect(incremental.cosmetic).toBe(0);
    expect(incremental.reparsed).toBe(1);
    expect(snapshot(incremental.snapshotId)).toEqual(await fullIndexSnapshot(project.rootDir));
  });

  it("reuses byte-identical files by default (no flag)", async () => {
    const first = await index();
    const second = await index();
    expect(second.reused).toBe(first.files);
    expect(second.reparsed).toBe(0);
  });

  it("does not reuse anything when incremental is disabled", async () => {
    await index();
    const second = await index({ incremental: false });
    expect(second.reused).toBe(0);
    expect(second.reparsed).toBe(second.files);
  });

  it("writes fingerprints on every run, enabling later reuse", async () => {
    await index({ incremental: false });
    const second = await index();
    expect(second.reused).toBe(second.files);
  });

  it("keeps SOURCE_METRIC_NAMES in sync with what computeSourceMetrics emits", async () => {
    const files = await Promise.all(
      ["a.ts", "b.ts", "c.ts"].map(async (name) =>
        parseFile(await fs.readFile(src(name), "utf-8"), src(name), "typescript"),
      ),
    );

    const emitted = new Set(computeSourceMetrics(files, (p) => p).map((m) => m.name));

    for (const name of emitted) {
      expect(SOURCE_METRIC_NAMES.has(name)).toBe(true);
    }
  });
});
