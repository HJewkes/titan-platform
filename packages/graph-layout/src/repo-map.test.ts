import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import type { GraphEdge, GraphNode } from "@titan-design/code-graph";
import { collapseToDirectories } from "./collapse-directories.js";
import { collapseToPackages } from "./collapse-packages.js";
import { ELK_VERSION, MAP_LABEL_METRICS, emitRepoMap } from "./repo-map.js";
import type { MapBox, MapLayout, MapNode, MapPoint } from "./repo-map-types.js";
import type { GraphInput } from "./types.js";

// A made-up three-package notes app: web (two directories), api (two), store (one).
const file = (id: string): GraphNode => ({ id, kind: "file", name: id.split("/").pop()!, role: "source" });
const imports = (srcId: string, dstId: string): GraphEdge => ({ srcId, dstId, kind: "imports" });
const calls = (srcId: string, dstId: string): GraphEdge => ({ srcId, dstId, kind: "calls" });

const APP = "packages/web/src/ui/app.tsx";
const LIST = "packages/web/src/ui/list.tsx";
const FORM = "packages/web/src/ui/form.tsx";
const HTTP = "packages/web/src/client/http.ts";
const NOTES_ROUTE = "packages/api/src/routes/notes.ts";
const USERS_ROUTE = "packages/api/src/routes/users.ts";
const SESSION = "packages/api/src/auth/session.ts";
const DB = "packages/store/src/db.ts";
const NOTES_STORE = "packages/store/src/notes.ts";

const threePackages: GraphInput = {
  snapshotId: 1,
  nodes: [APP, LIST, FORM, HTTP, NOTES_ROUTE, USERS_ROUTE, SESSION, DB, NOTES_STORE].map(file),
  edges: [
    imports(APP, LIST),
    imports(APP, FORM),
    imports(LIST, HTTP),
    imports(FORM, HTTP),
    imports(HTTP, NOTES_ROUTE),
    imports(NOTES_ROUTE, SESSION),
    imports(USERS_ROUTE, SESSION),
    imports(NOTES_ROUTE, NOTES_STORE),
    calls(NOTES_ROUTE, NOTES_STORE),
    calls(USERS_ROUTE, DB),
    imports(NOTES_STORE, DB),
  ],
};

const inside = (outer: MapBox, inner: MapBox): boolean =>
  inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;

// A route end sits on its box's border; 1 px covers the 0.5 px rounding of centres and points.
const touches = (b: MapBox, [x, y]: MapPoint): boolean =>
  x >= b.x - 1 && x <= b.x + b.w + 1 && y >= b.y - 1 && y <= b.y + b.h + 1;

function ancestorAt(map: MapLayout, fileId: string, level: number): string {
  const byId = new Map(map.nodes.map((n) => [n.id, n]));
  let node: MapNode | undefined = byId.get(fileId);
  while (node && node.level > level) node = node.parentId ? byId.get(node.parentId) : undefined;
  if (!node) throw new Error(`no level ${level} ancestor for ${fileId}`);
  return node.id;
}

// A fixed reordering, so a failure reproduces.
function shuffled<T>(items: readonly T[]): T[] {
  return [...items.slice(3), ...items.slice(0, 3)].reverse();
}

describe("emitRepoMap", () => {
  it("places every node's box inside its parent's box (catches dropping ELK's parent offset)", async () => {
    const map = await emitRepoMap(threePackages);
    const byId = new Map(map.nodes.map((n) => [n.id, n]));

    expect(byId.size).toBe(map.nodes.length);
    expect(new Set(map.nodes.map((n) => n.level))).toEqual(new Set([1, 2, 3]));
    for (const node of map.nodes.filter((n) => n.parentId !== undefined)) {
      const parent = byId.get(node.parentId!);
      expect(parent?.level, `${node.id} is deeper than its parent`).toBeLessThan(node.level);
      expect(inside(parent!.box, node.box), `${node.id} inside ${node.parentId}`).toBe(true);
    }
  });

  it("routes every edge at every level from its source box to its target box (catches L1 edges left unrouted)", async () => {
    const map = await emitRepoMap(threePackages);
    const byId = new Map(map.nodes.map((n) => [n.id, n]));

    expect(new Set(map.edges.map((e) => e.level))).toEqual(new Set([1, 2, 3]));
    for (const edge of map.edges) {
      const route = edge.route ?? [];
      expect(route.length, `${edge.id} routed`).toBeGreaterThanOrEqual(2);
      expect(touches(byId.get(edge.source)!.box, route[0]!), `${edge.id} starts on its source`).toBe(true);
      expect(touches(byId.get(edge.target)!.box, route.at(-1)!), `${edge.id} ends on its target`).toBe(true);
    }
  });

  it("attaches every collapse edge to the group boxes holding its files (catches moduleLabel used as the id)", async () => {
    const map = await emitRepoMap(threePackages);
    const mapPairs = new Set(map.edges.map((e) => `${e.level} ${e.source} ${e.target}`));
    const someFile = (inGroup: (id: string) => boolean): string => threePackages.nodes.find((n) => inGroup(n.id))!.id;

    const packageEdges = collapseToPackages(threePackages).edges;
    const directoryEdges = collapseToDirectories(threePackages).edges;
    expect(packageEdges.length).toBeGreaterThan(0);
    expect(directoryEdges.length).toBeGreaterThan(0);
    for (const e of packageEdges) {
      const [src, dst] = [e.srcId, e.dstId].map((pkg) => someFile((id) => id.startsWith(`packages/${pkg}/`)));
      expect(mapPairs).toContain(`1 ${ancestorAt(map, src!, 1)} ${ancestorAt(map, dst!, 1)}`);
    }
    for (const e of directoryEdges) {
      const [src, dst] = [e.srcId, e.dstId].map((dir) => someFile((id) => id.slice(0, id.lastIndexOf("/")) === dir));
      expect(mapPairs).toContain(`2 ${ancestorAt(map, src!, 2)} ${ancestorAt(map, dst!, 2)}`);
    }
  });

  it("gives equal shas and layouts for two runs and for shuffled input (catches an unsorted sha payload)", async () => {
    const first = await emitRepoMap(threePackages);
    const again = await emitRepoMap(threePackages);
    const reordered = await emitRepoMap({
      ...threePackages,
      nodes: shuffled(threePackages.nodes),
      edges: shuffled(threePackages.edges),
    });

    expect(first.sha).toMatch(/^[0-9a-f]{64}$/);
    expect(again).toEqual(first);
    expect(reordered).toEqual(first);
  });

  it("changes the sha when the graph changes (catches a sha that ignores its inputs)", async () => {
    const before = await emitRepoMap(threePackages);
    const after = await emitRepoMap({ ...threePackages, edges: [...threePackages.edges, imports(SESSION, DB)] });

    expect(after.sha).not.toBe(before.sha);
  });

  it("pins the sha's ELK version to the installed elkjs (catches an elkjs bump that leaves old shas valid)", () => {
    const manifest = createRequire(import.meta.url).resolve("elkjs/package.json");

    expect(JSON.parse(readFileSync(manifest, "utf8")).version).toBe(ELK_VERSION);
  });

  it("rejects when ELK throws instead of falling back to a grid (catches catch-and-grid kept)", async () => {
    await expect(emitRepoMap(threePackages, { layoutOptions: { algorithm: "no.such.algorithm" } })).rejects.toThrow();
  });

  it("keeps a directory's highest-degree files and folds the rest into +N more (catches pruning by id order)", async () => {
    const dir = "packages/big/src";
    const ids = ["a", "b", "c", "d", "e", "f", "g", "h"].map((n) => `${dir}/${n}.ts`);
    const hub = `${dir}/h.ts`;
    const input: GraphInput = {
      snapshotId: 1,
      nodes: ids.map(file),
      edges: [imports(hub, `${dir}/g.ts`), imports(hub, `${dir}/a.ts`), imports(`${dir}/g.ts`, `${dir}/f.ts`)],
    };

    const map = await emitRepoMap(input, { maxFilesPerBox: 4 });
    const files = map.nodes.filter((n) => n.level === 3);

    expect(files.map((n) => n.label)).toEqual(["+5 more", "a.ts", "g.ts", "h.ts"]);
    expect(files.find((n) => n.kind === "overflow")?.hidden).toBe(5);
    expect(map.edges.filter((e) => e.level === 3).map((e) => e.id)).toEqual([
      `${dir}/h.ts->${dir}/a.ts`,
      `${dir}/h.ts->${dir}/g.ts`,
    ]);
  });

  it("sizes file boxes to their 44 px label and groups to hold their header (catches dropped group headers)", async () => {
    const wideDir = "packages/web/src/notification-preferences/a.ts";
    const map = await emitRepoMap({ ...threePackages, nodes: [...threePackages.nodes, file(wideDir)] });
    const byId = new Map(map.nodes.map((n) => [n.id, n]));
    const { fontSize, charWidth = 0.6, padding } = MAP_LABEL_METRICS;
    const labelWidth = (text: string): number => Math.ceil(text.length * charWidth * fontSize + 2 * padding);
    const headerHeight = Math.ceil(fontSize + 2 * padding);

    const session = byId.get(SESSION)!;
    expect(session.box.w).toBe(labelWidth("session.ts"));
    expect(session.box.h).toBe(headerHeight);
    for (const group of map.nodes.filter((n) => n.level < 3)) {
      expect(group.box.w, `${group.id} fits its label`).toBeGreaterThanOrEqual(labelWidth(group.label));
    }
    for (const child of map.nodes.filter((n) => n.parentId)) {
      const header = byId.get(child.parentId!)!.box;
      expect(child.box.y, `${child.id} sits below its parent's header`).toBeGreaterThanOrEqual(header.y + headerHeight);
    }
  });

  it("labels an edge call only when every folded edge is a call (catches the import/call flag inverted)", async () => {
    const map = await emitRepoMap(threePackages);
    const sourceOf = (src: string, dst: string): string | undefined =>
      map.edges.find((e) => e.source === src && e.target === dst)?.edgeSource;

    expect(sourceOf(USERS_ROUTE, DB)).toBe("call");
    expect(sourceOf(NOTES_ROUTE, NOTES_STORE)).toBe("import");
  });
});
