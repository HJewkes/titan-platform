import { describe, expect, it } from "vitest";
import {
  compareBaseline,
  deadExportMessage,
  entryFiles,
  findDeadExports,
  formatReport,
  updatedBaseline,
} from "./dead-code-check.mjs";

const file = (id, role = "source") => ({ id, kind: "file", name: id.split("/").pop(), role });
const symbol = (fileId, name, exported = true) => ({
  id: `${fileId}#${name}`,
  kind: "symbol",
  name,
  parentId: fileId,
  attrs: { exported },
});
const edge = (srcId, dstId, kind) => ({ srcId, dstId, kind });
const ids = (findings) => findings.map((f) => f.id);

const PKG = "packages/demo";
const INDEX = `${PKG}/src/index.ts`;
const API = `${PKG}/src/api.ts`;
const INTERNAL = `${PKG}/src/internal.ts`;
const HELPER = `${PKG}/src/helper.ts`;

function demoGraph() {
  const nodes = [file(INDEX, "barrel"), file(API), file(INTERNAL), file(HELPER)];
  nodes.push(symbol(API, "publicFn"), symbol(INTERNAL, "orphan"), symbol(INTERNAL, "used"), symbol(HELPER, "local", false));
  const edges = [edge(INDEX, API, "re-exports"), edge(API, `${INTERNAL}#used`, "references")];
  return { nodes, edges };
}

function deadIn({ nodes, edges }, packages = [{ dir: PKG, manifest: {} }]) {
  const files = new Map(nodes.filter((n) => n.kind === "file").map((n) => [n.id, n]));
  return ids(findDeadExports({ nodes, edges, entries: entryFiles(packages, files) }));
}

describe("finding exports with no importer", () => {
  it("lists a non-entry module export that no other file imports", () => {
    expect(deadIn(demoGraph())).toEqual([`${INTERNAL}#orphan`]);
  });

  it("never lists an export the package entry re-exports, since consumer repos may import it", () => {
    expect(deadIn(demoGraph())).not.toContain(`${API}#publicFn`);
  });

  it("follows re-exports through an intermediate barrel to the declaring module", () => {
    const { nodes, edges } = demoGraph();
    const mid = `${PKG}/src/mid/index.ts`;
    nodes.push(file(mid, "barrel"));
    edges.push(edge(INDEX, mid, "re-exports"), edge(mid, INTERNAL, "re-exports"));
    expect(deadIn({ nodes, edges })).toEqual([]);
  });

  it("treats a package.json subpath export as an entry, mapping dist back to src", () => {
    const { nodes, edges } = demoGraph();
    const vite = `${PKG}/src/vite/index.ts`;
    nodes.push(file(vite, "barrel"), symbol(vite, "plugin"));
    const manifest = { exports: { ".": { import: "./dist/index.js" }, "./vite": { types: "./dist/vite.d.ts", import: "./dist/vite.js" } } };
    expect(deadIn({ nodes, edges }, [{ dir: PKG, manifest }])).not.toContain(`${vite}#plugin`);
  });

  it("does not count a use inside the declaring file as an importer", () => {
    const { nodes, edges } = demoGraph();
    edges.push(edge(INTERNAL, `${INTERNAL}#orphan`, "calls"));
    expect(deadIn({ nodes, edges })).toContain(`${INTERNAL}#orphan`);
  });

  it("counts a test file's import as an importer and skips exports declared in tests", () => {
    const { nodes, edges } = demoGraph();
    const test = `${PKG}/src/internal.test.ts`;
    nodes.push(file(test, "test"), symbol(test, "fixtureFactory"));
    edges.push(edge(test, `${INTERNAL}#orphan`, "references"));
    expect(deadIn({ nodes, edges })).toEqual([]);
  });
});

describe("the shrink-only baseline", () => {
  const finding = (id) => ({ id, name: id.split("#")[1], file: id.split("#")[0] });

  it("fails only on a dead export the baseline does not hold", () => {
    const result = compareBaseline([finding("a.ts#old"), finding("b.ts#new")], ["a.ts#old"]);
    expect(ids(result.fresh)).toEqual(["b.ts#new"]);
    expect(ids(result.carried)).toEqual(["a.ts#old"]);
  });

  it("reports a baselined export removed from the code as fixed, never as a failure", () => {
    const result = compareBaseline([], ["a.ts#gone"]);
    expect(result.fresh).toEqual([]);
    expect(result.fixed).toEqual(["a.ts#gone"]);
  });

  it("drops fixed entries on update and never adds a new finding", () => {
    expect(updatedBaseline([finding("a.ts#old"), finding("b.ts#new")], ["a.ts#old", "c.ts#gone"])).toEqual(["a.ts#old"]);
  });

  it("seeds a missing baseline with every current finding", () => {
    expect(updatedBaseline([finding("a.ts#x")], null)).toEqual(["a.ts#x"]);
  });
});

describe("the report", () => {
  it("prints the R12 remediation for a new dead export", () => {
    expect(deadExportMessage({ name: "orphan", file: "src/internal.ts" })).toBe(
      "`orphan` in `src/internal.ts` has no importer. Delete it and its tests. If an external consumer needs it, export it from the package entry.",
    );
  });

  it("says a report-only run does not fail", () => {
    const fresh = [{ id: "a.ts#x", name: "x", file: "a.ts" }];
    expect(formatReport({ fresh, carried: [], fixed: [] }, { reportOnly: true })).toContain("report-only, not failing");
  });
});
