#!/usr/bin/env node
// Inventory for the L1 legibility study: candidate boundary rules computed on the real
// package graph and the element counts each yields. Prints JSON.
// Usage: node tools/l1-protos/inventory.mjs <snapshot.json>
import { loadRepo } from "./lib/graph.mjs";
import { byCommunity, byPrefix, byTier, groupsOf, layerOf, ruleStats } from "./lib/boundaries.mjs";

const PRODUCT_DIR = /^(products|apps)\//;

// The products that transitively import a package; packages with the same consumer set group together.
function byConsumers(packages, edges) {
  const users = new Map(packages.map((p) => [p.id, edges.filter((e) => e.dst === p.id).map((e) => e.src)]));
  const memo = new Map();
  const consumers = (id, seen = new Set()) => {
    if (memo.has(id)) return memo.get(id);
    if (seen.has(id)) return new Set();
    seen.add(id);
    const out = new Set(PRODUCT_DIR.test(id) ? [id] : []);
    for (const u of users.get(id)) for (const c of consumers(u, seen)) out.add(c);
    memo.set(id, out);
    return out;
  };
  return (p) => {
    const set = [...consumers(p.id)].sort();
    if (PRODUCT_DIR.test(p.id)) return `product:${p.id}`;
    return set.length === 0 ? "consumers:none" : set.length > 2 ? "consumers:shared" : `consumers:${set.join("+")}`;
  };
}

const { packages, pkgEdges } = await loadRepo(process.argv[2]);
const layers = layerOf(packages, pkgEdges);
const rules = {
  tier: byTier,
  prefix: byPrefix(packages),
  consumers: byConsumers(packages, pkgEdges),
  louvain: byCommunity(packages, pkgEdges, 1),
  "louvain-r0.6": byCommunity(packages, pkgEdges, 0.6),
  "tier×louvain": (p) => `${byTier(p)}/${byCommunity(packages, pkgEdges, 1)(p)}`,
  layer: (p) => `layer:${layers.get(p.id)}`,
};
const report = {
  packages: packages.length,
  packageEdges: pkgEdges.length,
  rules: Object.fromEntries(
    Object.entries(rules).map(([name, rule]) => [name, { ...ruleStats(packages, pkgEdges, rule), members: groupsOf(packages, rule) }]),
  ),
};
console.log(JSON.stringify(report, null, 1));
