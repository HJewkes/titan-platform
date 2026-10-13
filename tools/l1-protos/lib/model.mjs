// The hierarchy above packages: system → area → package → directory → file. Areas come from
// Louvain at a low resolution (so there are at most ~7), with packages that have no package
// edge pooled into one "standalone" area. The CI tier is a second, orthogonal axis.
import { byCommunity } from "./boundaries.mjs";

export const AREA_RESOLUTION = 0.2;
const STANDALONE = "area:standalone";
const PRODUCT_DIR = /^(products|apps)\//;

export function shortName(id) {
  return id.replace(PRODUCT_DIR, "");
}

function degrees(edges) {
  const fanIn = new Map();
  const fanOut = new Map();
  for (const e of edges) {
    fanIn.set(e.dst, (fanIn.get(e.dst) ?? 0) + 1);
    fanOut.set(e.src, (fanOut.get(e.src) ?? 0) + 1);
  }
  return { fanIn, fanOut };
}

// A priori interest (van Ham & Perer's API term): fan-in dominates, size breaks ties.
export function interestOf(pkg, deg) {
  return 3 * (deg.fanIn.get(pkg.id) ?? 0) + (deg.fanOut.get(pkg.id) ?? 0) + Math.log2(1 + pkg.counts.source);
}

// An area is named for its member with the most edges inside the area (the ACDC dominator idea, cheaply).
function areaName(members, edges) {
  const inside = new Set(members.map((p) => p.id));
  const score = (p) => edges.filter((e) => inside.has(e.src) && inside.has(e.dst) && (e.src === p.id || e.dst === p.id)).length;
  const hub = [...members].sort((a, b) => score(b) - score(a) || (a.id < b.id ? -1 : 1))[0];
  return shortName(hub.id);
}

function assignAreas(packages, edges) {
  const linked = new Set(edges.flatMap((e) => [e.src, e.dst]));
  const community = byCommunity(packages, edges, AREA_RESOLUTION);
  return new Map(packages.map((p) => [p.id, linked.has(p.id) ? community(p).replace("comm:", "area:") : STANDALONE]));
}

/** Aggregated edges between whatever `keyOf` maps each package to, with summed weight and pair count. */
export function aggregate(edges, keyOf) {
  const out = new Map();
  for (const e of edges) {
    const [s, d] = [keyOf(e.src, e.dst), keyOf(e.dst, e.src)];
    if (!s || !d || s === d) continue;
    const id = `${s}>${d}`;
    const cur = out.get(id) ?? { id, src: s, dst: d, weight: 0, pairs: 0 };
    cur.weight += e.weight;
    cur.pairs += 1;
    out.set(id, cur);
  }
  return [...out.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
}

/** Areas with members (by interest, highest first), names and file totals. */
export function buildModel(repo) {
  const { packages, pkgEdges } = repo;
  const deg = degrees(pkgEdges);
  const areaOf = assignAreas(packages, pkgEdges);
  const byId = new Map(packages.map((p) => [p.id, { ...p, area: areaOf.get(p.id), interest: interestOf(p, deg) }]));
  const areas = new Map();
  for (const p of byId.values()) areas.set(p.area, [...(areas.get(p.area) ?? []), p]);
  const list = [...areas].map(([id, members]) => ({
    id,
    name: id === STANDALONE ? "standalone" : areaName(members, pkgEdges),
    members: members.sort((a, b) => b.interest - a.interest || (a.id < b.id ? -1 : 1)),
    files: members.reduce((n, p) => n + p.counts.source, 0),
  }));
  list.sort((a, b) => b.members.length - a.members.length || (a.id < b.id ? -1 : 1));
  return { packages: byId, areas: list, pkgEdges, deg, files: repo.files, packageOf: repo.layout.packageOf };
}
