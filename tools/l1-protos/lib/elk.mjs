// A thin wrapper over the elkjs that graph-layout already depends on. graph-layout's own
// entry points take root-level options only; these prototypes need per-node options (layer
// constraints for border bands, partitions for tier bands), so they build the ELK graph
// here and read absolute coordinates back (`elk.json.*Coords: ROOT`).
import { createRequire } from "node:module";
import path from "node:path";
import { ROOT } from "./graph.mjs";
import { SPACING } from "./scene.mjs";

const require = createRequire(path.join(ROOT, "packages/graph-layout/package.json"));
const ELK = require("elkjs/lib/elk.bundled.js");

// Spacing comes from config (em fractions of the label floor); the rest pins the algorithm.
// Layered with these options is deterministic: no random seed is read and node order is the
// input order, which every caller sorts.
export const BASE_OPTIONS = {
  algorithm: "layered",
  "elk.direction": "DOWN",
  "elk.edgeRouting": "ORTHOGONAL",
  "elk.hierarchyHandling": "INCLUDE_CHILDREN",
  ...SPACING.overview,
  ...SPACING.edges,
  "elk.json.shapeCoords": "ROOT",
  "elk.json.edgeCoords": "ROOT",
};

function toElkNode(n, kids) {
  // A present-but-undefined width crashes elkjs on a compound node, so containers omit the keys.
  const size = n.w === undefined ? {} : { width: n.w, height: n.h };
  const node = { id: n.id, ...size, layoutOptions: n.options ?? {} };
  const children = kids.get(n.id);
  if (children) node.children = children.map((c) => toElkNode(c, kids));
  return node;
}

function boxesOf(node, out) {
  for (const c of node.children ?? []) {
    out.set(c.id, { x: c.x, y: c.y, w: c.width, h: c.height });
    boxesOf(c, out);
  }
  return out;
}

function routesOf(node, out) {
  for (const e of node.edges ?? []) {
    const s = e.sections?.[0];
    if (s) out.set(e.id, [s.startPoint, ...(s.bendPoints ?? []), s.endPoint].map((p) => ({ x: p.x, y: p.y })));
  }
  for (const c of node.children ?? []) routesOf(c, out);
  return out;
}

/**
 * Lays out `nodes` ({id, w, h, parent?, options?}) and `edges` ({id, src, dst}); returns
 * top-left boxes and absolute polylines keyed by id. Input order is the model order, so
 * callers sort for determinism.
 */
export async function layout(nodes, edges, options = {}) {
  const kids = new Map();
  for (const n of nodes) kids.set(n.parent ?? "root", [...(kids.get(n.parent ?? "root") ?? []), n]);
  const graph = {
    id: "root",
    layoutOptions: { ...BASE_OPTIONS, ...options },
    children: (kids.get("root") ?? []).map((n) => toElkNode(n, kids)),
    edges: edges.map((e) => ({ id: e.id, sources: [e.src], targets: [e.dst] })),
  };
  const laid = await new ELK().layout(graph);
  return { boxes: boxesOf(laid, new Map()), routes: routesOf(laid, new Map()), width: laid.width, height: laid.height };
}
