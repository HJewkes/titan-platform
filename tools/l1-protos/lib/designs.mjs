// The five candidate views, each built on the real model at runtime. Every builder returns
// a scene in layout units: { name, title, subtitle, elements, width, height, notes }.
import { layout } from "./elk.mjs";
import { aggregate, shortName } from "./model.mjs";
import { CONTAINER_TOP, FONT, FRAME, LIMITS, PAD, SPACING, boxSize, edgeElement, element, fitTransform, strokeFor, withinBudget } from "./scene.mjs";
import { placeHeaders, placePills } from "./labels.mjs";

// The caps are derived per frame (config.mjs): the smaller of the cognitive ceiling and the
// geometric capacity of the content area at the label floor.
export const CAP = { boxes: LIMITS.caps.boxes, edges: LIMITS.caps.edges, labelPx: FONT, topGroups: LIMITS.caps.groups };
// Tighter layer channels for the nested views, which otherwise run taller than the frame.
export const COMPACT = SPACING.compact;

function containerOptions(lines, extra = {}) {
  const { w } = boxSize(lines);
  return {
    "elk.padding": `[top=${CONTAINER_TOP},left=${PAD},bottom=${PAD},right=${PAD}]`,
    "elk.nodeSize.constraints": "MINIMUM_SIZE",
    "elk.nodeSize.minimum": `(${w}, ${CONTAINER_TOP + 40})`,
    ...extra,
  };
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

// Turn laid-out nodes and edges into scene elements; `spec` maps id → { kind, lines }.
function sceneFrom(laid, spec, edges, labelOf = () => null) {
  const elements = [];
  for (const [id, s] of spec) elements.push(element(id, s.kind, s.lines, laid.boxes.get(id), s.extra));
  const labelled = [];
  for (const e of edges) {
    const points = laid.routes.get(e.id);
    if (!points) continue;
    const edge = edgeElement(e.id, points, { sw: strokeFor(e.pairs ?? 1), cls: e.cls });
    elements.push(edge);
    const text = labelOf(e);
    if (text) labelled.push([edge, text]);
  }
  const { pills, dropped } = placePills(elements, labelled);
  const headersMoved = placeHeaders(elements);
  return { elements: [...elements, ...pills], width: laid.width, height: laid.height, pillsDropped: dropped, headersMoved };
}

function leaf(id, kind, lines, extra = {}) {
  return { id, kind, lines, ...boxSize(lines), ...extra };
}

function addLeaf(nodes, spec, n) {
  nodes.push({ id: n.id, w: n.w, h: n.h, parent: n.parent, options: n.options });
  spec.set(n.id, { kind: n.kind, lines: n.lines, extra: { parent: n.parent, ...n.extra } });
}

function areaLines(area) {
  return [area.name, `${plural(area.members.length, "pkg")} · ${area.files} files`];
}

/** D2 area overview: one card per area, summary edges labelled with package-edge counts. */
export async function areaOverview(model) {
  const nodes = [];
  const spec = new Map();
  for (const a of model.areas) addLeaf(nodes, spec, leaf(a.id, "box", areaLines(a)));
  const edges = aggregate(model.pkgEdges, (id) => model.packages.get(id).area);
  const laid = await layout(nodes, edges);
  const scene = sceneFrom(laid, spec, edges, (e) => String(e.pairs));
  return { ...scene, name: "d2-area-overview", title: `D2 · area overview (${model.areas.length} areas)`, subtitle: "areas = Louvain communities of the package graph · edge label = package edges" };
}

// Which visible element a package collapses to when only `open` areas show their top k.
function visibleKey(model, open, k) {
  return (pkgId) => {
    const p = model.packages.get(pkgId);
    const area = model.areas.find((a) => a.id === p.area);
    if (!open.has(area.id)) return area.id;
    return area.members.indexOf(p) < k ? `pkg:${p.id}` : `more:${area.id}`;
  };
}

// Edges that cross areas end on the area box (a card, or an open area's border), so an open
// area adds only its internal edges; the border is where outside edges enter and leave.
function crossAtArea(model, key) {
  const areaOf = (id) => model.packages.get(id).area;
  return (id, other) => (other !== undefined && areaOf(id) !== areaOf(other) ? areaOf(id) : key(id));
}

function openArea(nodes, spec, area, k, undrawn, elisions) {
  // One header line: a second line costs a line pitch of height, which is what the frame runs short of.
  const lines = [`${area.name} · ${plural(area.members.length, "pkg")}${undrawn > 0 ? ` · ${undrawn} edges cut` : ""}`];
  // Laid out on its own, a container does not inherit the root's options, so it repeats them.
  nodes.push({ id: area.id, options: containerOptions(lines, { algorithm: "layered", "elk.direction": "DOWN", "elk.edgeRouting": "ORTHOGONAL", ...COMPACT }) });
  spec.set(area.id, { kind: "container", lines });
  for (const p of area.members.slice(0, k)) addLeaf(nodes, spec, leaf(`pkg:${p.id}`, "box", [shortName(p.id)], { parent: area.id }));
  const hidden = area.members.length - k;
  if (hidden > 0) addLeaf(nodes, spec, leaf(`more:${area.id}`, "tile", [`+${hidden} more`], { parent: area.id }));
  if (hidden > 0) elisions.push({ what: "packages", hidden, in: `more:${area.id}` });
  if (undrawn > 0) elisions.push({ what: "edges", hidden: undrawn, in: area.id });
}

// Keeps the overview's left-to-right order inside each layer, so an expand moves cards less.
export const MODEL_ORDER = { "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES", "elk.layered.crossingMinimization.forceNodeModelOrder": "true" };

function inHintOrder(areas, hint) {
  if (!hint) return areas;
  return [...areas].sort((a, b) => hint.indexOf(a.id) - hint.indexOf(b.id));
}

/** Box ids of a laid-out scene, top to bottom then left to right: the order the next view keeps. */
export function readingOrder(scene) {
  return scene.elements.filter((e) => e.kind === "box" || e.kind === "tile").sort((a, b) => a.y - b.y || a.x - b.x).map((e) => e.id);
}

// Area-level edges are kept first, then package edges, then edges into a "+N more" tile.
function expandRank(e) {
  const ends = [e.src, e.dst];
  if (ends.some((x) => x.startsWith("more:"))) return 2;
  return ends.some((x) => x.startsWith("pkg:")) ? 1 : 0;
}

/** D3 expand in place: `openIds` areas show their top k packages; the rest stay cards. */
export async function expandInPlace(model, openIds, k = 5, orderHint = null) {
  const open = new Set(openIds);
  const all = aggregate(model.pkgEdges, crossAtArea(model, visibleKey(model, open, k)));
  const { kept: edges, dropped } = withinBudget(all, CAP.edges, expandRank);
  const areaOfKey = (key) => model.packages.get(key.replace(/^pkg:/, ""))?.area ?? key.replace(/^more:/, "");
  const nodes = [];
  const spec = new Map();
  const elisions = [];
  for (const a of inHintOrder(model.areas, orderHint)) {
    if (open.has(a.id)) openArea(nodes, spec, a, k, dropped.filter((e) => areaOfKey(e.src) === a.id).length, elisions);
    else addLeaf(nodes, spec, leaf(a.id, "box", areaLines(a)));
  }
  // Every cross-area edge ends on an area border, so each open area can be laid out on its own
  // (bottom-up) and sized to its contents instead of stretching across global layers.
  const options = { ...COMPACT, "elk.hierarchyHandling": "SEPARATE_CHILDREN" };
  const laid = await layout(nodes, edges, orderHint ? { ...options, ...MODEL_ORDER } : options);
  const scene = sceneFrom(laid, spec, edges, (e) => (expandRank(e) === 0 && e.pairs > 1 ? String(e.pairs) : null));
  const names = openIds.map((id) => model.areas.find((a) => a.id === id).name).join(" + ");
  const subtitle = `top ${k} per open area by fan-in · outside edges end on the area border · ${dropped.length}/${all.length} edges cut`;
  return { ...scene, k, open: openIds.length, elisions, name: "d3-expand-in-place", title: `D3 · expand in place (${names})`, subtitle };
}

/** One line per rejected try, so a frame reports every fallback it took. */
export function fallbackNote(label, scene) {
  const c = FRAME.content;
  return `${label}: ${Math.round(scene.width)}x${Math.round(scene.height)} exceeds ${c.width}x${c.height}`;
}

/**
 * D3 at the largest per-area k (≤ `kMax`) whose layout fits the frame unscaled at the label floor.
 * Fallback order: lower k, then collapse the last open area back to a card; with one area left,
 * k = 0 (its packages all behind "+N more") is the last resort before switching design (D2).
 */
export async function expandFitted(model, openIds, kMax, orderHint = null) {
  const tries = [];
  for (let open = openIds.length; open >= 1; open--) {
    for (let k = kMax; k >= 1; k--) tries.push([open, k]);
  }
  tries.push([1, 0]);
  const fallbacks = [];
  let scene;
  for (const [open, k] of tries) {
    scene = await expandInPlace(model, openIds.slice(0, open), k, orderHint);
    if (fitTransform(scene.width, scene.height).s >= 1) break;
    fallbacks.push(fallbackNote(`open ${open} k ${k}`, scene));
  }
  if (fitTransform(scene.width, scene.height).s < 1) fallbacks.push("exhausted: switch design (D2)");
  return { ...scene, fallbacks };
}

export { addLeaf, leaf, plural };
