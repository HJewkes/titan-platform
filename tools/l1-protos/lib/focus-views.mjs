// D4 (one area entered) and D5 (one package entered, top-k files), both under the cap.
import { CAP, PROXIES_PER_BAND, capProxies, fitStubs, containerOptions, focusEdges, focusElisions, focusScene, proxyNodes, refold, shortName, wrapLines } from "./focus.mjs";
import { LIMITS, boxSize, charFor, fitTransform } from "./scene.mjs";
import { MODEL_ORDER, fallbackNote } from "./designs.mjs";
import { crossingBudget, crossingCount } from "./rules.mjs";

function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

// A focus container's label says how many edges the cap cut or moved to its border.
function budgetLines(head, cut, rerouted) {
  const tail = [cut > 0 ? `${cut} inner edges cut` : "", rerouted > 0 ? `${rerouted} stubs on border` : ""].filter(Boolean);
  return tail.length ? [head, tail.join(" · ")] : [head];
}

function leafNode(nodes, spec, id, kind, lines, parent) {
  nodes.push({ id, ...boxSize(lines, 0, charFor(id, kind)), parent });
  spec.set(id, { kind, lines });
}

// The container itself carries no text; its header goes to the gutter (focusScene `headers`).
function containerNode(nodes, spec, id, lines, parent) {
  nodes.push({ id, parent, options: containerOptions([]) });
  spec.set(id, { kind: "container", lines: [] });
  return { of: id, lines: wrapLines(lines.join(" · ")) };
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

// Fewest edges a focus view keeps when crossings force the budget down: one stub per band side.
const EDGE_BUDGET_FLOOR = 4;

// Lower k until the scene fits unscaled; once it fits, lower the edge budget while the routes
// cross more than the budget allows. Every rejected try is recorded; k = 1 and the edge floor
// are the ends, after which the only fallback is another design.
async function fitted(build, k0, step) {
  const fallbacks = [];
  let [k, edges] = [k0, CAP.edges];
  for (;;) {
    const scene = await build(k, edges);
    const fits = fitTransform(scene.width, scene.height).s >= 1;
    const [crossings, budget] = [crossingCount(scene.elements), crossingBudget(scene.elements, LIMITS)];
    if (fits && crossings <= budget) return { ...scene, fallbacks };
    if (fits) {
      if (edges <= EDGE_BUDGET_FLOOR) return { ...scene, fallbacks: [...fallbacks, `edges ${edges}: ${crossings} crossings > ${budget}, at the edge floor`] };
      fallbacks.push(`edges ${edges} → ${Math.max(EDGE_BUDGET_FLOOR, Math.floor(edges * 0.8))}: ${crossings} crossings > ${budget}`);
      edges = Math.max(EDGE_BUDGET_FLOOR, Math.floor(edges * 0.8));
      continue;
    }
    fallbacks.push(fallbackNote(`k ${k}`, scene));
    if (k <= 1) return { ...scene, fallbacks: [...fallbacks, "exhausted: switch design"] };
    k -= step(k);
  }
}

/**
 * D4 at the largest package count (≤ the box cap) whose layout fits the frame at the label
 * floor. A "+1 more" tile costs the same box as the package it hides, so k never stops one short.
 */
export async function areaFocus(model, areaId, orderHint = null) {
  const area = model.areas.find((a) => a.id === areaId);
  const probe = bordered(areaEdges(model, area, area.members.length), (id) => areaNameOf(model, id));
  const room = Math.max(1, CAP.boxes - 2 - probe.proxies.length);
  const k0 = area.members.length <= room + 1 ? area.members.length : room;
  return fitted((k, edges) => areaFocusAt(model, area, k, orderHint, edges), k0, (k) => (k === area.members.length ? 2 : 1));
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

async function areaFocusAt(model, area, k, orderHint, edgeBudget = CAP.edges) {
  const { edges: all, proxies } = bordered(areaEdges(model, area, k), (id) => areaNameOf(model, id));
  const { edges, cut, rerouted } = fitStubs(all, area.id, edgeBudget);
  const nodes = [];
  const spec = new Map();
  const header = containerNode(nodes, spec, area.id, budgetLines(`${area.name} · ${plural(area.members.length, "pkg")}`, cut, rerouted));
  for (const p of hinted(area.members.slice(0, k), orderHint)) leafNode(nodes, spec, `pkg:${p.id}`, "box", [shortName(p.id)], area.id);
  if (area.members.length > k) leafNode(nodes, spec, `more:${area.id}`, "tile", [`+${area.members.length - k} more`], area.id);
  const scene = await focusScene(nodes, spec, edges, proxies, orderHint ? MODEL_ORDER : {}, [header]);
  const elisions = focusElisions(area.id, proxies, cut, rerouted);
  if (area.members.length > k) elisions.push({ what: "packages", hidden: area.members.length - k, in: `more:${area.id}` });
  const subtitle = "other areas as proxies · top band: what imports the focus · bottom band: what it imports";
  return { ...scene, k, elisions, name: "d4-area-focus", title: `D4 · area focus (${area.name}) with border bands`, subtitle };
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

/** D5 at the largest file count (≤ the box cap) whose layout fits the frame at the label floor. */
export async function packageFocus(model, pkgId) {
  const { ranked } = fileStats(model, pkgId);
  const probe = bordered(fileEdges(model, pkgId, new Set(ranked.slice(0, FILES_MAX).map((f) => f.id))).edges, shortName);
  const k0 = Math.max(1, Math.min(FILES_MAX, CAP.boxes - 2 - probe.proxies.length));
  return fitted((k, edges) => packageFocusAt(model, pkgId, k, edges), k0, () => 1);
}

/** D5: one package, its top-k files (dir/name labels), the rest counted in one tile. */
async function packageFocusAt(model, pkgId, k, edgeBudget = CAP.edges) {
  const pkg = model.packages.get(pkgId);
  const { files, ranked } = fileStats(model, pkgId);
  const shownFiles = ranked.slice(0, k);
  const shown = new Set(shownFiles.map((f) => f.id));
  const { edges: raw, total } = fileEdges(model, pkgId, shown);
  const root = `pkg:${pkgId}`;
  const { edges: all, proxies } = bordered(raw, shortName);
  const { edges, cut, rerouted } = fitStubs(all, root, edgeBudget);
  const nodes = [];
  const spec = new Map();
  const header = containerNode(nodes, spec, root, budgetLines(`${shortName(pkgId)} · ${files.length} files`, cut, rerouted));
  for (const f of shownFiles) leafNode(nodes, spec, `file:${f.id}`, "box", [fileLabel(f, pkg.dir)], root);
  leafNode(nodes, spec, `more:${pkgId}`, "tile", hiddenLines(pkg, files, shown), root);
  const scene = await focusScene(nodes, spec, edges, proxies, {}, [header]);
  const drawn = edges.reduce((n, e) => n + e.pairs, 0);
  const elisions = focusElisions(root, proxies, cut, rerouted);
  elisions.push({ what: "files", hidden: files.filter((f) => !shown.has(f.id) && f.role !== "types").length, in: `more:${pkgId}` });
  const subtitle = `files ranked by fan-in, barrels excluded · ${drawn} of ${total} file edges drawn as ${edges.length} lines`;
  return { ...scene, k, elisions, name: "d5-package-focus", title: `D5 · package focus (${shortName(pkgId)}): top ${shownFiles.length} files`, subtitle };
}
