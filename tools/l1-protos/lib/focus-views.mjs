// D4 (one area entered) and D5 (one package entered, top-k files), both under the cap.
import { CAP, capProxies, fitStubs, containerOptions, focusEdges, focusScene, proxyNodes, refold, shortName } from "./focus.mjs";
import { boxSize, fitTransform } from "./scene.mjs";
import { MODEL_ORDER } from "./designs.mjs";

const PROXIES_PER_BAND = 4;

function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

// A focus container's label says how many edges the cap cut or moved to its border.
function budgetLines(head, cut, rerouted) {
  const tail = [cut > 0 ? `${cut} inner edges cut` : "", rerouted > 0 ? `${rerouted} stubs on border` : ""].filter(Boolean);
  return tail.length ? [head, tail.join(" · ")] : [head];
}

function leafNode(nodes, spec, id, kind, lines, parent) {
  nodes.push({ id, ...boxSize(lines), parent });
  spec.set(id, { kind, lines });
}

function containerNode(nodes, spec, id, lines, parent) {
  nodes.push({ id, parent, options: containerOptions(lines) });
  spec.set(id, { kind: "container", lines });
}

function withoutProxyPairs(edges) {
  return edges.filter((e) => !(/^(top|bot):/.test(e.src) && /^(top|bot):/.test(e.dst)));
}

// The proxies and edges around a focus; returns the proxy nodes and edges after folding.
function bordered(rawEdges, nameOf) {
  const edges = withoutProxyPairs(rawEdges);
  const { fold, hidden } = capProxies(edges, PROXIES_PER_BAND);
  const folded = refold(edges, fold);
  return { edges: folded, proxies: proxyNodes(folded, nameOf, hidden) };
}

/**
 * D4 at the largest package count (≤ the box cap) whose layout fits the frame at 24 px. A
 * "+1 more" tile costs the same box as the package it hides, so k never stops one short.
 */
export async function areaFocus(model, areaId, orderHint = null) {
  const area = model.areas.find((a) => a.id === areaId);
  const probe = bordered(areaEdges(model, area, area.members.length), (id) => areaNameOf(model, id));
  const room = CAP.boxes - 2 - probe.proxies.length;
  let k = area.members.length <= room + 1 ? area.members.length : room;
  for (;;) {
    const scene = await areaFocusAt(model, area, k, orderHint);
    if (fitTransform(scene.width, scene.height).s >= 1 || k <= 3) return scene;
    k -= k === area.members.length ? 2 : 1;
  }
}

function areaNameOf(model, id) {
  return model.areas.find((a) => a.id === id).name;
}

function areaEdges(model, area, k) {
  return focusEdges(model.pkgEdges, (id, side) => {
    const p = model.packages.get(id);
    if (p.area !== area.id) return `${side}:${p.area}`;
    return area.members.indexOf(p) < k ? `pkg:${id}` : `more:${area.id}`;
  });
}

// Packages in the previous view's reading order, so the transition into this view moves them less.
function hinted(packages, orderHint) {
  if (!orderHint) return packages;
  const rank = (p) => (orderHint.includes(`pkg:${p.id}`) ? orderHint.indexOf(`pkg:${p.id}`) : Infinity);
  return [...packages].sort((a, b) => rank(a) - rank(b));
}

async function areaFocusAt(model, area, k, orderHint) {
  const { edges: all, proxies } = bordered(areaEdges(model, area, k), (id) => areaNameOf(model, id));
  const { edges, cut, rerouted } = fitStubs(all, area.id, CAP.edges);
  const nodes = [];
  const spec = new Map();
  containerNode(nodes, spec, area.id, budgetLines(`${area.name} · ${plural(area.members.length, "pkg")}`, cut, rerouted));
  for (const p of hinted(area.members.slice(0, k), orderHint)) leafNode(nodes, spec, `pkg:${p.id}`, "box", [shortName(p.id)], area.id);
  if (area.members.length > k) leafNode(nodes, spec, `more:${area.id}`, "tile", [`+${area.members.length - k} more`], area.id);
  const scene = await focusScene(nodes, spec, edges, proxies, orderHint ? MODEL_ORDER : {});
  const subtitle = "other areas as proxies · top band: what imports the focus · bottom band: what it imports";
  return { ...scene, name: "d4-area-focus", title: `D4 · area focus (${area.name}) with border bands`, subtitle };
}

const FILES_MAX = 10;

// Barrels are excluded from the ranking: they top every fan-in list but carry no logic.
function fileStats(model, pkgId) {
  const pkgOf = model.packageOf;
  const files = model.files.nodes.filter((n) => pkgOf(n.id) === pkgId);
  const inside = new Set(files.map((f) => f.id));
  const score = new Map(files.map((f) => [f.id, 0]));
  for (const e of model.files.edges) {
    if (inside.has(e.dstId)) score.set(e.dstId, score.get(e.dstId) + (inside.has(e.srcId) ? 2 : 3));
    if (inside.has(e.srcId)) score.set(e.srcId, score.get(e.srcId) + 1);
  }
  const ranked = files.filter((f) => f.role !== "barrel").sort((a, b) => score.get(b.id) - score.get(a.id) || (a.id < b.id ? -1 : 1));
  return { files, ranked };
}

function fileLabel(file, pkgDir) {
  const rel = file.id.slice(pkgDir.length + 1).replace(/^src\//, "");
  return rel.replace(/\.tsx?$/, "");
}

// An outside edge to a hidden file ends on the package border; an edge between two files
// inside the package needs both shown.
function fileEdges(model, pkgId, shown) {
  const pkgOf = model.packageOf;
  const root = `pkg:${pkgId}`;
  const keyed = [];
  for (const e of model.files.edges) {
    const [inS, inD] = [pkgOf(e.srcId) === pkgId, pkgOf(e.dstId) === pkgId];
    if (!inS && !inD) continue;
    const key = (id, inside, side) => (!inside ? `${side}:${pkgOf(id)}` : shown.has(id) ? `file:${id}` : inS && inD ? null : root);
    keyed.push({ src: key(e.srcId, inS, "top"), dst: key(e.dstId, inD, "bot") });
  }
  const usable = keyed.filter((e) => e.src && e.dst);
  return { edges: focusEdges(usable, (id) => id), total: keyed.length };
}

function hiddenLines(pkg, files, shown) {
  const hidden = files.filter((f) => !shown.has(f.id));
  const types = hidden.filter((f) => f.role === "types").length;
  return [`+${hidden.length - types} files`, `+${pkg.counts.test} tests · +${types} types`, "not shown"];
}

/** D5 at the largest file count (≤ the box cap) whose layout fits the frame at 24 px. */
export async function packageFocus(model, pkgId) {
  const { ranked } = fileStats(model, pkgId);
  const probe = bordered(fileEdges(model, pkgId, new Set(ranked.slice(0, FILES_MAX).map((f) => f.id))).edges, shortName);
  let k = Math.min(FILES_MAX, CAP.boxes - 2 - probe.proxies.length);
  for (;;) {
    const scene = await packageFocusAt(model, pkgId, k);
    if (fitTransform(scene.width, scene.height).s >= 1 || k <= 3) return scene;
    k -= 1;
  }
}

/** D5: one package, its top-k files (dir/name labels), the rest counted in one tile. */
async function packageFocusAt(model, pkgId, k) {
  const pkg = model.packages.get(pkgId);
  const { files, ranked } = fileStats(model, pkgId);
  const shownFiles = ranked.slice(0, k);
  const shown = new Set(shownFiles.map((f) => f.id));
  const { edges: raw, total } = fileEdges(model, pkgId, shown);
  const root = `pkg:${pkgId}`;
  const { edges: all, proxies } = bordered(raw, shortName);
  const { edges, cut, rerouted } = fitStubs(all, root, CAP.edges);
  const nodes = [];
  const spec = new Map();
  containerNode(nodes, spec, root, budgetLines(`${shortName(pkgId)} · ${files.length} files`, cut, rerouted));
  for (const f of shownFiles) leafNode(nodes, spec, `file:${f.id}`, "box", [fileLabel(f, pkg.dir)], root);
  leafNode(nodes, spec, `more:${pkgId}`, "tile", hiddenLines(pkg, files, shown), root);
  const scene = await focusScene(nodes, spec, edges, proxies);
  const drawn = edges.reduce((n, e) => n + e.pairs, 0);
  const subtitle = `files ranked by fan-in, barrels excluded · ${drawn} of ${total} file edges drawn as ${edges.length} lines`;
  return { ...scene, name: "d5-package-focus", title: `D5 · package focus (${shortName(pkgId)}): top ${shownFiles.length} files`, subtitle };
}
