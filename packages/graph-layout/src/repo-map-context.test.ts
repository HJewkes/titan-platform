import { describe, expect, it } from "vitest";
import type { GraphEdge, GraphNode } from "@titan-design/code-graph";
import { emitRepoMap } from "./repo-map.js";
import type { RepoMapContext } from "./repo-map-context.js";
import type { MapBox, MapLayout, MapNode } from "./repo-map-types.js";
import type { GraphInput } from "./types.js";

const CLI = "packages/notes-cli/src/main.ts";
const CORE = "packages/notes-core/src/notes.ts";
const STORE = "packages/notes-store/src/store.ts";

const file = (id: string): GraphNode => ({ id, kind: "file", name: id.split("/").pop()!, role: "source" });
const imports = (srcId: string, dstId: string): GraphEdge => ({ srcId, dstId, kind: "imports" });

const notes: GraphInput = {
  snapshotId: 1,
  nodes: [CLI, CORE, STORE].map(file),
  edges: [imports(CLI, CORE), imports(CORE, STORE)],
};

const context: RepoMapContext = {
  actors: [
    { id: "actor:author", label: "Author" },
    { id: "actor:reviewer", label: "Reviewer" },
  ],
  externals: [{ id: "ext:sync", label: "Sync service" }],
  links: [
    { from: "actor:author", to: "sys", label: "writes notes" },
    { from: "actor:reviewer", to: "pkg:notes-cli", label: "reads notes" },
    { from: "pkg:notes-store", to: "ext:sync", label: "pushes changes" },
  ],
};

// The map this fixture produced before the context pass existed.
const SHA_WITHOUT_CONTEXT = "8b728beda06a3f61d2ecff382a83c9f4b41e21d250697c79c0de80b156f51d37";

const overlaps = (a: MapBox, b: MapBox): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

const inside = (inner: MapBox, outer: MapBox): boolean =>
  inner.x >= outer.x &&
  inner.y >= outer.y &&
  inner.x + inner.w <= outer.x + outer.w &&
  inner.y + inner.h <= outer.y + outer.h;

/** Distance from a point to the outline of a box. */
function borderDistance([px, py]: readonly [number, number], b: MapBox): number {
  const dx = Math.max(b.x - px, 0, px - (b.x + b.w));
  const dy = Math.max(b.y - py, 0, py - (b.y + b.h));
  if (dx > 0 || dy > 0) return Math.hypot(dx, dy);
  return Math.min(px - b.x, b.x + b.w - px, py - b.y, b.y + b.h - py);
}

const node = (map: MapLayout, id: string): MapNode => {
  const found = map.nodes.find((n) => n.id === id);
  if (!found) throw new Error(`no node ${id}`);
  return found;
};

describe("emitRepoMap level-0 context pass on the notes fixture", () => {
  it("keeps every actor and external outside the sys box", async () => {
    const map = await emitRepoMap(notes, { context });
    const sys = node(map, "sys");

    const outsiders = ["actor:author", "actor:reviewer", "ext:sync"].map((id) => node(map, id));
    for (const outsider of outsiders) {
      expect(outsider.level).toBe(0);
      expect(outsider.parentId).toBeUndefined();
      expect(overlaps(outsider.box, sys.box), `${outsider.id} clear of sys`).toBe(false);
    }
  });

  it("puts every package box inside the sys box, as its child", async () => {
    const map = await emitRepoMap(notes, { context });
    const sys = node(map, "sys");

    const packages = map.nodes.filter((n) => n.id.startsWith("pkg:"));
    expect(packages).toHaveLength(3);
    for (const pkg of packages) {
      expect(pkg.parentId).toBe("sys");
      expect(inside(pkg.box, sys.box), `${pkg.id} inside sys`).toBe(true);
    }
    expect(map.levels.map((l) => l.id)).toEqual([0, 1, 2, 3]);
  });

  it("routes an actor to sys arrow that ends on the sys border", async () => {
    const map = await emitRepoMap(notes, { context });
    const sys = node(map, "sys");

    const edge = map.edges.find((e) => e.source === "actor:author" && e.target === "sys");
    expect(edge?.level).toBe(0);
    expect(edge?.edgeSource).toBe("protocol");
    expect(edge?.label).toBe("writes notes");
    expect(edge?.route?.length).toBeGreaterThanOrEqual(2);
    expect(borderDistance(edge!.route!.at(-1)!, sys.box)).toBeLessThanOrEqual(1);
  });

  it("throws on a link to an id that is not sys, a package, an actor or an external", async () => {
    const unknown = { ...context, links: [{ from: "actor:author", to: "pkg:missing", label: "reads" }] };

    await expect(emitRepoMap(notes, { context: unknown })).rejects.toThrow(/pkg:missing/);
  });

  it("leaves the map without a level 0 and with its old sha when no context is given", async () => {
    const map = await emitRepoMap(notes);

    expect(map.levels.map((l) => l.id)).toEqual([1, 2, 3]);
    expect(map.nodes.some((n) => n.level === 0)).toBe(false);
    expect(map.sha).toBe(SHA_WITHOUT_CONTEXT);
  });
});
