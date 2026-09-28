import { describe, it, expect, beforeAll } from "vitest";
import { Project } from "ts-morph";
import { parseFile } from "@titan-design/code-parser";
import { TsMorphGraphExtractor } from "./ts-morph-extractor.js";
import type { GraphFragment } from "../types.js";
import { buildFixture, REPO_ROOT, type Fixture } from "./ts-morph-extractor.test-helpers.js";

let fixture: Fixture;

beforeAll(async () => {
  fixture = await buildFixture();
});

describe("TsMorphGraphExtractor", () => {
  it("returns one fragment per TS file", () => {
    const fragments = fixture.extract("/repo/src/index.ts");
    expect(fragments).toHaveLength(1);
  });

  it("returns an empty array for non-TS files", async () => {
    const project = new Project({ useInMemoryFileSystem: true });
    const extractor = new TsMorphGraphExtractor({
      repoRoot: REPO_ROOT,
      project,
    });
    const fakePython = await parseFile(
      "x = 1\n",
      "/repo/script.py",
      "python",
    );
    expect(extractor.extract(fakePython)).toEqual([]);
  });

  it("emits a file node with the relative path id", () => {
    const [fragment] = fixture.extract("/repo/src/index.ts");
    const fileNode = fragment!.nodes.find((n) => n.kind === "file");
    expect(fileNode).toBeDefined();
    expect(fileNode!.id).toBe("src/index.ts");
    expect(fileNode!.parentId).toBe("src/index");
    expect(fileNode!.language).toBe("typescript");
  });

  it("emits a module node with the extension stripped", () => {
    const [fragment] = fixture.extract("/repo/src/index.ts");
    const moduleNode = fragment!.nodes.find((n) => n.kind === "module");
    expect(moduleNode).toBeDefined();
    expect(moduleNode!.id).toBe("src/index");
    expect(moduleNode!.parentId).toBe("src");
  });

  it("emits internal imports as edges to file ids", () => {
    const [fragment] = fixture.extract("/repo/src/index.ts");
    const imports = fragment!.edges.filter((e) => e.kind === "imports");
    const internalDsts = imports
      .map((e) => e.dstId)
      .filter((id) => !id.startsWith("npm:") && !id.startsWith("node:"));
    expect(internalDsts.sort()).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("emits node: external nodes verbatim", () => {
    const [fragment] = fixture.extract("/repo/src/index.ts");
    const ext = fragment!.nodes.find(
      (n) => n.kind === "external" && n.id === "node:fs/promises",
    );
    expect(ext).toBeDefined();
    const edge = fragment!.edges.find(
      (e) => e.kind === "imports" && e.dstId === "node:fs/promises",
    );
    expect(edge).toBeDefined();
    expect(edge!.attrs).toEqual({ specifier: "node:fs/promises", weight: 1 });
  });

  it("emits npm: external nodes for bare npm packages", () => {
    const [fragment] = fixture.extract("/repo/src/index.ts");
    const ext = fragment!.nodes.find(
      (n) => n.kind === "external" && n.id === "npm:typescript",
    );
    expect(ext).toBeDefined();
  });

  it("strips subpaths from scoped npm specifiers", () => {
    const [fragment] = fixture.extract("/repo/src/only-external.ts");
    const ids = fragment!.nodes
      .filter((n) => n.kind === "external")
      .map((n) => n.id)
      .sort();
    expect(ids).toEqual(["node:path", "npm:@scope/pkg"]);
  });

  it("emits re-export edges with the re-exports kind", () => {
    const [fragment] = fixture.extract("/repo/src/index.ts");
    const reExports = fragment!.edges.filter((e) => e.kind === "re-exports");
    expect(reExports).toHaveLength(1);
    expect(reExports[0]!.srcId).toBe("src/index.ts");
    expect(reExports[0]!.dstId).toBe("src/a.ts");
  });

  describe("reference-count edge weights (C-51)", () => {
    const weightOf = (
      fragment: GraphFragment,
      kind: string,
      dstId: string,
    ): unknown => {
      const edge = fragment.edges.find(
        (e) => e.kind === kind && e.dstId === dstId,
      );
      return edge?.attrs?.weight;
    };

    it("counts each use of a named import", () => {
      const [fragment] = fixture.extract("/repo/src/heavy.ts");
      expect(weightOf(fragment!, "imports", "src/a.ts")).toBe(3);
    });

    it("counts an aliased import by its local name", () => {
      const [fragment] = fixture.extract("/repo/src/heavy.ts");
      expect(weightOf(fragment!, "imports", "src/b.ts")).toBe(1);
    });

    it("counts namespace uses but excludes member-name positions", () => {
      const [fragment] = fixture.extract("/repo/src/heavy.ts");
      expect(weightOf(fragment!, "imports", "npm:typescript")).toBe(2);
    });

    it("folds parallel imports of one module into a summed edge", () => {
      const [fragment] = fixture.extract("/repo/src/folded.ts");
      const toA = fragment!.edges.filter(
        (e) => e.kind === "imports" && e.dstId === "src/a.ts",
      );
      expect(toA).toHaveLength(1);
      expect(toA[0]!.attrs?.weight).toBe(3);
    });

    it("floors a side-effect import at 1", () => {
      const [fragment] = fixture.extract("/repo/src/edge-cases.ts");
      expect(weightOf(fragment!, "imports", "src/c.ts")).toBe(1);
    });

    it("floors an imported-but-unused binding at 1", () => {
      const [fragment] = fixture.extract("/repo/src/edge-cases.ts");
      expect(weightOf(fragment!, "imports", "src/b.ts")).toBe(1);
    });

    it("weights a namespace re-export at 1", () => {
      const [fragment] = fixture.extract("/repo/src/reexport.ts");
      expect(weightOf(fragment!, "re-exports", "src/a.ts")).toBe(1);
    });

    it("weights a named re-export by its specifier count", () => {
      const [fragment] = fixture.extract("/repo/src/reexport.ts");
      expect(weightOf(fragment!, "re-exports", "src/multi.ts")).toBe(2);
    });
  });

  describe("per-symbol nodes and references (C-53)", () => {
    const symbolIds = (fragment: GraphFragment): string[] =>
      fragment.nodes
        .filter((n) => n.kind === "symbol")
        .map((n) => n.id)
        .sort();
    const refTo = (fragment: GraphFragment, dstId: string) =>
      fragment.edges.find((e) => e.kind === "references" && e.dstId === dstId);

    it("emits a symbol node per exported declaration", () => {
      const [fragment] = fixture.extract("/repo/src/multi.ts");
      const syms = fragment!.nodes.filter((n) => n.kind === "symbol");
      expect(symbolIds(fragment!)).toEqual(["src/multi.ts#P", "src/multi.ts#Q"]);
      expect(syms[0]).toMatchObject({
        kind: "symbol",
        name: "P",
        parentId: "src/multi.ts",
      });
    });

    it("does not emit symbol nodes for re-exported names (only own declarations)", () => {
      // index.ts declares only `x`; it `export *`s A from a.ts and imports B.
      const [fragment] = fixture.extract("/repo/src/index.ts");
      expect(symbolIds(fragment!)).toEqual(["src/index.ts#x"]);
    });

    it("emits a references edge to the imported export, weighted by use count", () => {
      const [fragment] = fixture.extract("/repo/src/heavy.ts");
      expect(refTo(fragment!, "src/a.ts#A")?.attrs?.weight).toBe(3);
      expect(refTo(fragment!, "src/b.ts#B")?.attrs?.weight).toBe(1);
    });

    it("does not emit per-symbol references for namespace imports", () => {
      const [fragment] = fixture.extract("/repo/src/heavy.ts");
      const nsRefs = fragment!.edges.filter(
        (e) => e.kind === "references" && e.dstId.startsWith("npm:"),
      );
      expect(nsRefs).toEqual([]);
    });

    it("resolves references through a barrel to the origin symbol", () => {
      const [fragment] = fixture.extract("/repo/src/via-barrel.ts");
      // Credits origin src/a.ts#A, never the barrel's src/index.ts#A.
      expect(refTo(fragment!, "src/a.ts#A")?.attrs?.weight).toBe(2);
      expect(refTo(fragment!, "src/index.ts#A")).toBeUndefined();
    });

    it("sees through an extensionless multi-hop re-export chain to the origin (C-70)", () => {
      const [fragment] = fixture.extract("/repo/src/deep/consumer.ts");
      // deepFn is imported extensionlessly through named-barrel → wildcard-barrel
      // → origin. The reference must credit the origin symbol, never the barrels.
      expect(refTo(fragment!, "src/deep/origin.ts#deepFn")?.attrs?.weight).toBe(2);
      expect(refTo(fragment!, "src/deep/named-barrel.ts#deepFn")).toBeUndefined();
      expect(refTo(fragment!, "src/deep/wildcard-barrel.ts#deepFn")).toBeUndefined();
    });

    it("credits the origin (inward) name across an aliased extensionless re-export hop (C-70)", () => {
      const [fragment] = fixture.extract("/repo/src/deep/consumer-alias.ts");
      // outward `renamedFn` ← inward `deepFn`; the origin declares `deepFn`.
      expect(refTo(fragment!, "src/deep/origin.ts#deepFn")?.attrs?.weight).toBe(1);
      expect(refTo(fragment!, "src/deep/aliased-barrel.ts#renamedFn")).toBeUndefined();
    });

    it("tags an exported declaration's symbol node exported:true", () => {
      const [fragment] = fixture.extract("/repo/src/multi.ts");
      const p = fragment!.nodes.find((n) => n.id === "src/multi.ts#P");
      expect(p?.attrs?.exported).toBe(true);
    });
  });

});
