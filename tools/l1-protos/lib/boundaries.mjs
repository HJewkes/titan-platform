// Candidate rules that split the package graph into groups (the tier above packages).
// Each rule maps a package id to a group id; `ruleStats` counts what a view built on it shows.

const PRODUCT_DIR = /^(products|apps)\//;

export function byTier(pkg) {
  return `tier:${pkg.tier}`;
}

// The name stem before the first dash, kept only when two or more packages share it.
export function byPrefix(packages) {
  const stem = (p) => (PRODUCT_DIR.test(p.id) ? "product" : p.id.split("-")[0]);
  const counts = new Map();
  for (const p of packages) counts.set(stem(p), (counts.get(stem(p)) ?? 0) + 1);
  return (p) => (counts.get(stem(p)) > 1 ? `prefix:${stem(p)}` : `solo:${p.id}`);
}

function undirected(ids, edges) {
  const adj = new Map(ids.map((id) => [id, new Map()]));
  for (const e of edges) {
    if (e.src === e.dst) continue;
    const w = Math.log2(1 + e.weight);
    adj.get(e.src).set(e.dst, (adj.get(e.src).get(e.dst) ?? 0) + w);
    adj.get(e.dst).set(e.src, (adj.get(e.dst).get(e.src) ?? 0) + w);
  }
  return adj;
}

function bestMove(id, adj, comm, tot, deg, m2, resolution) {
  const links = new Map();
  for (const [nb, w] of adj.get(id)) links.set(comm.get(nb), (links.get(comm.get(nb)) ?? 0) + w);
  const own = comm.get(id);
  tot.set(own, tot.get(own) - deg.get(id));
  let [best, gain] = [own, (links.get(own) ?? 0) - (resolution * tot.get(own) * deg.get(id)) / m2];
  for (const [c, w] of [...links].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const g = w - (resolution * tot.get(c) * deg.get(id)) / m2;
    if (g > gain + 1e-9) [best, gain] = [c, g];
  }
  tot.set(best, tot.get(best) + deg.get(id));
  return best;
}

/**
 * One-level Louvain modularity on the undirected package graph (weights log-damped so one
 * heavy pair does not dominate). Deterministic: nodes visit in id order.
 */
export function byCommunity(packages, edges, resolution = 1) {
  const ids = packages.map((p) => p.id).sort();
  const adj = undirected(ids, edges);
  const deg = new Map(ids.map((id) => [id, [...adj.get(id).values()].reduce((a, b) => a + b, 0)]));
  const m2 = [...deg.values()].reduce((a, b) => a + b, 0) || 1;
  const comm = new Map(ids.map((id) => [id, id]));
  const tot = new Map(ids.map((id) => [id, deg.get(id)]));
  for (let pass = 0, moved = true; moved && pass < 50; pass++) {
    moved = false;
    for (const id of ids) {
      const next = bestMove(id, adj, comm, tot, deg, m2, resolution);
      if (next !== comm.get(id)) [moved] = [true, comm.set(id, next)];
    }
  }
  return (p) => `comm:${comm.get(p.id)}`;
}

// Longest path from a sink (a package nothing below it imports), the layer ELK's DOWN flow tends toward.
export function layerOf(packages, edges) {
  const out = new Map();
  const deps = new Map(packages.map((p) => [p.id, edges.filter((e) => e.src === p.id).map((e) => e.dst)]));
  const visit = (id, seen = new Set()) => {
    if (out.has(id)) return out.get(id);
    if (seen.has(id)) return 0;
    seen.add(id);
    const l = Math.max(-1, ...deps.get(id).map((d) => visit(d, seen))) + 1;
    out.set(id, l);
    return l;
  };
  for (const p of packages) visit(p.id);
  return out;
}

/** What a view that draws one box per group would show. */
export function ruleStats(packages, edges, groupOf) {
  const group = new Map(packages.map((p) => [p.id, groupOf(p)]));
  const sizes = new Map();
  for (const g of group.values()) sizes.set(g, (sizes.get(g) ?? 0) + 1);
  const between = new Set();
  let intra = 0;
  for (const e of edges) {
    const [a, b] = [group.get(e.src), group.get(e.dst)];
    if (a === b) intra++;
    else between.add(`${a}>${b}`);
  }
  const sorted = [...sizes.values()].sort((a, b) => b - a);
  return { groups: sizes.size, largest: sorted[0], singletons: sorted.filter((s) => s === 1).length, groupEdges: between.size, intraEdges: intra };
}

/** Members per group, groups sorted by size then id. */
export function groupsOf(packages, groupOf) {
  const out = new Map();
  for (const p of packages) {
    const g = groupOf(p);
    out.set(g, [...(out.get(g) ?? []), p.id]);
  }
  return [...out].sort((a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1));
}
