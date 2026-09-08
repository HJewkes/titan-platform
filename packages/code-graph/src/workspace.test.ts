import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { indexPaths } from "./indexer.js";
import { openCodeGraph, type CodeGraphStore } from "./store.js";

const PACKAGES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * The property `pnpm dag:check` depends on: an import of a workspace package by
 * its published name has to land on the *source* file of that package, not on an
 * `npm:` external. ts-morph resolves the specifier through the package's `types`
 * entry (`dist/index.d.ts`), which the file walk excludes, so the extractor remaps
 * it back to `src/`. That makes `pnpm build` a prerequisite of this test, exactly
 * as it is of `dag:check` — CI runs build before test for the same reason.
 */
describe("indexing this workspace", () => {
  let tmp: string;
  let store: CodeGraphStore;
  let snapshotId: number;

  beforeAll(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "code-graph-ws-"));
    store = openCodeGraph(path.join(tmp, "graph.sqlite3"));
    const result = await indexPaths(store, {
      paths: [path.join(PACKAGES, "daemon/src"), path.join(PACKAGES, "registry/src")],
      ref: "wd",
      detectRenames: false,
    });
    snapshotId = result.snapshotId;
  }, 60_000);

  afterAll(async () => {
    store.close();
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("roots node ids at the git toplevel, not at the walked subtree", () => {
    const ids = store.listNodes(snapshotId).map((n) => n.id);
    expect(ids).toContain("packages/registry/src/index.ts");
    expect(ids).toContain("packages/daemon/src/daemon.ts");
  });

  it("resolves a cross-package import of @titan-design/registry onto the package source", () => {
    const edges = store.listEdges(snapshotId).filter((e) => e.kind === "imports");
    const crossPackage = edges.filter(
      (e) => e.srcId.startsWith("packages/daemon/") && e.dstId.startsWith("packages/registry/"),
    );
    expect(crossPackage.length).toBeGreaterThan(0);
    expect(crossPackage.every((e) => e.dstId === "packages/registry/src/index.ts")).toBe(true);
    expect(edges.some((e) => e.dstId === "npm:@titan-design/registry")).toBe(false);
  });

  it("classifies the package barrel and its tests", () => {
    const nodes = store.listNodes(snapshotId);
    expect(nodes.find((n) => n.id === "packages/registry/src/index.ts")?.role).toBe("barrel");
    expect(nodes.find((n) => n.id === "packages/registry/src/envelope.test.ts")?.role).toBe("test");
  });
});
