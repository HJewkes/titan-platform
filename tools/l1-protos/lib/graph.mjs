// Reads a code-graph snapshot (written by snapshot.mjs) and the workspace metadata at
// runtime and derives the package graph every prototype draws. Nothing here is committed
// data: the snapshot lives outside the repo.
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SOURCE_ROLES = new Set(["source", "entry", "barrel", "types"]);

export async function loadLayout() {
  return import(path.join(ROOT, "packages/graph-layout/dist/index.js"));
}

// The tier map CI enforces (`package-layers` in .codewatch/check.json), keyed by package id.
export function tierMap(packageOf) {
  const check = JSON.parse(readFileSync(path.join(ROOT, ".codewatch/check.json"), "utf8"));
  const rule = check.rules.find((r) => r.$tiers);
  const out = new Map();
  for (const [tier, dirs] of Object.entries(rule?.$tiers ?? {})) {
    for (const dir of dirs) out.set(packageOf(`${dir}/x`), tier);
  }
  return out;
}

function manifestOf(pkgId) {
  const dir = pkgId.includes("/") ? pkgId : `packages/${pkgId}`;
  const file = path.join(ROOT, dir, "package.json");
  if (!existsSync(file)) return { dir };
  const json = JSON.parse(readFileSync(file, "utf8"));
  return { dir, name: json.name, description: json.description ?? "", keywords: json.keywords ?? [] };
}

function dedupedEdges(edges, ids) {
  const seen = new Set();
  return edges.filter((e) => {
    const key = JSON.stringify([e.srcId, e.dstId]);
    if (!ids.has(e.srcId) || !ids.has(e.dstId) || e.srcId === e.dstId || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function roleCounts(nodes, packageOf) {
  const out = new Map();
  for (const n of nodes) {
    if (n.kind !== "file") continue;
    const id = packageOf(n.id);
    const c = out.get(id) ?? { source: 0, test: 0, types: 0, other: 0 };
    const role = n.role === "types" ? "types" : SOURCE_ROLES.has(n.role) ? "source" : n.role === "test" ? "test" : "other";
    c[role] += 1;
    out.set(id, c);
  }
  return out;
}

/** Source files, their import edges, packages with tier/manifest/role counts, and package edges. */
export async function loadRepo(snapshotFile) {
  const layout = await loadLayout();
  const snap = JSON.parse(readFileSync(snapshotFile, "utf8"));
  const fileNodes = snap.nodes.filter((n) => n.kind === "file" && SOURCE_ROLES.has(n.role));
  const files = { snapshotId: snap.snapshotId, nodes: fileNodes, edges: dedupedEdges(snap.edges, new Set(fileNodes.map((n) => n.id))) };
  const collapsed = layout.collapseToPackages(files);
  const tiers = tierMap(layout.packageOf);
  const roles = roleCounts(snap.nodes, layout.packageOf);
  const packages = collapsed.nodes.map((n) => ({
    id: n.id,
    tier: tiers.get(n.id) ?? "?",
    ...manifestOf(n.id),
    counts: roles.get(n.id) ?? { source: 0, test: 0, types: 0, other: 0 },
  }));
  const pkgEdges = collapsed.edges.map((e) => ({ src: e.srcId, dst: e.dstId, weight: e.attrs?.weight ?? 1 }));
  return { layout, files, packages, pkgEdges };
}
