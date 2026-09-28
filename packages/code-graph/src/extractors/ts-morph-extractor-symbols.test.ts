import { describe, it, expect, beforeAll } from "vitest";
import type { GraphFragment } from "../types.js";
import { buildFixture, type Fixture } from "./ts-morph-extractor.test-helpers.js";

let fixture: Fixture;

beforeAll(async () => {
  fixture = await buildFixture();
});

describe("TsMorphGraphExtractor", () => {
  describe("model B: all-functions symbol nodes (C-64)", () => {
    const symById = (fragment: GraphFragment, id: string) =>
      fragment.nodes.find((n) => n.kind === "symbol" && n.id === id);

    it("emits symbol nodes for non-exported functions, methods, and classes", () => {
      const [fragment] = fixture.extract("/repo/src/model-b.ts");
      const ids = fragment!.nodes
        .filter((n) => n.kind === "symbol")
        .map((n) => n.id)
        .sort();
      // Methods are qualified by their class since TP-182.
      expect(ids).toEqual([
        "src/model-b.ts#Priv",
        "src/model-b.ts#Priv.run",
        "src/model-b.ts#arrow",
        "src/model-b.ts#helper",
        "src/model-b.ts#pub",
      ]);
    });

    it("flags exported vs internal declarations", () => {
      const [fragment] = fixture.extract("/repo/src/model-b.ts");
      expect(symById(fragment!, "src/model-b.ts#pub")?.attrs?.exported).toBe(true);
      expect(symById(fragment!, "src/model-b.ts#helper")?.attrs?.exported).toBe(false);
      expect(symById(fragment!, "src/model-b.ts#Priv")?.attrs?.exported).toBe(false);
      expect(symById(fragment!, "src/model-b.ts#Priv.run")?.attrs?.exported).toBe(false);
    });

    it("emits no symbol node for a non-callable internal const", () => {
      const [fragment] = fixture.extract("/repo/src/model-b.ts");
      expect(symById(fragment!, "src/model-b.ts#CONST")).toBeUndefined();
    });

    it("attaches a 1-based line span to function/class symbols (C-63)", () => {
      const [fragment] = fixture.extract("/repo/src/model-b.ts");
      // `pub` is the first line of the fixture; `helper` the second.
      expect(symById(fragment!, "src/model-b.ts#pub")?.attrs).toMatchObject({
        startLine: 1,
        endLine: 1,
      });
      expect(symById(fragment!, "src/model-b.ts#helper")?.attrs).toMatchObject({
        startLine: 2,
        endLine: 2,
      });
    });
  });

  describe("symbol signatures + docstrings (C-79)", () => {
    const symById = (fragment: GraphFragment, id: string) =>
      fragment.nodes.find((n) => n.kind === "symbol" && n.id === id);

    it("stores a one-line signature for an annotated function", () => {
      const [fragment] = fixture.extract("/repo/src/documented.ts");
      expect(symById(fragment!, "src/documented.ts#add")?.attrs?.signature).toBe(
        "add(a: number, b: number): number",
      );
    });

    it("stores the leading JSDoc as purpose", () => {
      const [fragment] = fixture.extract("/repo/src/documented.ts");
      expect(symById(fragment!, "src/documented.ts#add")?.attrs?.purpose).toBe(
        "Adds two numbers together.",
      );
    });

    it("signs an arrow-const export, a class, and a type alias", () => {
      const [fragment] = fixture.extract("/repo/src/documented.ts");
      expect(symById(fragment!, "src/documented.ts#scale")?.attrs?.signature).toBe(
        "scale(v: number): number",
      );
      expect(symById(fragment!, "src/documented.ts#Box")?.attrs?.signature).toBe("class Box");
      expect(symById(fragment!, "src/documented.ts#Id")?.attrs?.signature).toBe(
        "type Id = string | number",
      );
    });

    it("omits signature/purpose when undocumented (attrs stay minimal)", () => {
      const [fragment] = fixture.extract("/repo/src/documented.ts");
      // no JSDoc on `scale` → purpose absent, not null
      expect(symById(fragment!, "src/documented.ts#scale")?.attrs?.purpose).toBeUndefined();
    });

    it("infers a clean return type when the annotation is omitted", () => {
      // model-b `pub(x: number)` has no return annotation; `x > 0 ? x : -x`
      // infers to `number`, which carries no import() path so it is kept.
      const [fragment] = fixture.extract("/repo/src/model-b.ts");
      expect(symById(fragment!, "src/model-b.ts#pub")?.attrs?.signature).toBe(
        "pub(x: number): number",
      );
    });
  });

  describe("dynamic imports (C-65)", () => {
    it("emits an imports edge for a string-literal dynamic import()", () => {
      const [fragment] = fixture.extract("/repo/src/dyn.ts");
      const edge = fragment!.edges.find(
        (e) => e.kind === "imports" && e.dstId === "src/c.ts",
      );
      expect(edge).toBeDefined();
    });

    it("does not emit an edge for a computed (non-literal) dynamic import", () => {
      const [fragment] = fixture.extract("/repo/src/dyn.ts");
      // The only imports edge from dyn.ts is the literal ./c.js one.
      const importEdges = fragment!.edges.filter((e) => e.kind === "imports");
      expect(importEdges).toHaveLength(1);
      expect(importEdges[0]!.dstId).toBe("src/c.ts");
    });

    it("emits a references edge for a destructured dynamic import (C-68)", () => {
      const [fragment] = fixture.extract("/repo/src/dyn-destructure.ts");
      const refs = fragment!.edges.filter((e) => e.kind === "references");
      const targets = refs.map((e) => e.dstId);
      expect(targets).toContain("src/multi.ts#P");
    });

    it("credits the exported name, not the local alias, for `Q: qq` (C-68)", () => {
      const [fragment] = fixture.extract("/repo/src/dyn-destructure.ts");
      const targets = fragment!.edges
        .filter((e) => e.kind === "references")
        .map((e) => e.dstId);
      expect(targets).toContain("src/multi.ts#Q");
      expect(targets).not.toContain("src/multi.ts#qq");
    });

    it("does not emit a symbol reference for a namespace dynamic import (C-68)", () => {
      const [fragment] = fixture.extract("/repo/src/dyn-destructure.ts");
      // `const ns = await import("./c.js")` binds the whole module — module edge
      // only, no per-symbol reference (mirrors static `import *`).
      const refToC = fragment!.edges.find(
        (e) => e.kind === "references" && e.dstId.startsWith("src/c.ts#"),
      );
      expect(refToC).toBeUndefined();
    });

    it("still emits the module imports edge for a destructured dynamic import", () => {
      const [fragment] = fixture.extract("/repo/src/dyn-destructure.ts");
      const importTargets = fragment!.edges
        .filter((e) => e.kind === "imports")
        .map((e) => e.dstId);
      expect(importTargets).toContain("src/multi.ts");
    });
  });

  describe("extensionless relative imports (C-44)", () => {
    it("resolves an extensionless relative import to its file id", () => {
      const [fragment] = fixture.extract(
        "/repo/dashboard/src/views/OverviewView.tsx",
      );
      const dsts = fragment!.edges.map((e) => e.dstId);
      expect(dsts).toContain("dashboard/src/types.ts");
    });

    it("resolves a directory import to its index file", () => {
      const [fragment] = fixture.extract(
        "/repo/dashboard/src/views/OverviewView.tsx",
      );
      const dsts = fragment!.edges.map((e) => e.dstId);
      expect(dsts).toContain("dashboard/src/theme/index.ts");
    });

    it("never records a relative specifier as an npm external", () => {
      const [fragment] = fixture.extract(
        "/repo/dashboard/src/views/OverviewView.tsx",
      );
      const junk = fragment!.nodes.filter(
        (n) => n.id === "npm:.." || n.id === "npm:.",
      );
      expect(junk).toEqual([]);
      expect(fragment!.edges.some((e) => e.dstId.startsWith("npm:."))).toBe(
        false,
      );
    });

    it("drops an unresolvable relative import instead of bucketing it", () => {
      const [fragment] = fixture.extract(
        "/repo/dashboard/src/views/OverviewView.tsx",
      );
      const specifiers = fragment!.edges.map((e) => e.attrs?.specifier);
      expect(specifiers).not.toContain("../does-not-exist");
    });

    it("still emits bare npm specifiers alongside relative imports", () => {
      const [fragment] = fixture.extract(
        "/repo/dashboard/src/views/OverviewView.tsx",
      );
      expect(
        fragment!.nodes.some(
          (n) => n.kind === "external" && n.id === "npm:react",
        ),
      ).toBe(true);
    });
  });
});
