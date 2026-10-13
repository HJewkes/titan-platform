// Focus views: one area or one package fills the frame; everything outside it becomes a
// proxy chip on a border band (top: who imports into the focus, bottom: what it imports).
// Proxies sit in ELK's first and last layers, so every stub is a real routed edge.
import { layout } from "./elk.mjs";
import { shortName } from "./model.mjs";
import { CAP, COMPACT } from "./designs.mjs";
import { CONTAINER_TOP, PAD, boxSize, edgeElement, element, strokeFor } from "./scene.mjs";
import { placePills } from "./labels.mjs";

const BAND_PAD = 18;
const LAYER = { top: "FIRST", bot: "LAST" };

function containerOptions(lines) {
  const { w } = boxSize(lines);
  return {
    "elk.padding": `[top=${CONTAINER_TOP + (lines.length - 1) * 30},left=${PAD},bottom=${PAD},right=${PAD}]`,
    "elk.nodeSize.constraints": "MINIMUM_SIZE",
    "elk.nodeSize.minimum": `(${w}, ${CONTAINER_TOP + 40})`,
  };
}

function bump(map, id, src, dst, extra = {}) {
  const cur = map.get(id) ?? { id, src, dst, pairs: 0, ...extra };
  cur.pairs += 1;
  map.set(id, cur);
}

// Directed edges between visible keys; `keyOf(id, side)` names the element an end collapses to.
function focusEdges(edges, keyOf) {
  const out = new Map();
  for (const e of edges) {
    const s = keyOf(e.src, "top");
    const d = keyOf(e.dst, "bot");
    if (s && d && s !== d) bump(out, `${s}>${d}`, s, d);
  }
  return [...out.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
}

// Keep at most `limit` proxies per band; the rest fold into one "+N" chip on that band.
function capProxies(edges, limit) {
  const per = { top: new Map(), bot: new Map() };
  for (const e of edges) {
    for (const end of [e.src, e.dst]) {
      const side = end.slice(0, 3);
      if (per[side]) per[side].set(end, (per[side].get(end) ?? 0) + e.pairs);
    }
  }
  const fold = new Map();
  for (const side of ["top", "bot"]) {
    const ranked = [...per[side]].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    const keep = ranked.length > limit ? limit - 1 : limit;
    for (const [id] of ranked.slice(keep)) fold.set(id, `${side}:+more`);
  }
  return { fold, hidden: { top: Math.max(0, per.top.size - limit + 1), bot: Math.max(0, per.bot.size - limit + 1) } };
}

function refold(edges, fold) {
  const out = new Map();
  for (const e of edges) {
    const [s, d] = [fold.get(e.src) ?? e.src, fold.get(e.dst) ?? e.dst];
    const cur = out.get(`${s}>${d}`) ?? { id: `${s}>${d}`, src: s, dst: d, pairs: 0 };
    cur.pairs += e.pairs;
    out.set(cur.id, cur);
  }
  return [...out.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
}

function proxyNodes(edges, nameOf, hidden) {
  const ids = [...new Set(edges.flatMap((e) => [e.src, e.dst]).filter((id) => /^(top|bot):/.test(id)))].sort();
  return ids.map((id) => {
    const side = id.slice(0, 3);
    const lines = id.endsWith(":+more") ? [`+${hidden[side]} more`] : [nameOf(id.slice(4))];
    return { id, kind: "chip", lines, ...boxSize(lines), options: { "elk.layered.layering.layerConstraint": LAYER[side] } };
  });
}

const BAND_TEXT = [["top", "imported by"], ["bot", "imports"]];
const GUTTER = Math.max(...BAND_TEXT.map(([, t]) => boxSize([t]).w)) + PAD;

// Shift everything right so each band's label sits in a gutter left of the proxies, not under them.
function withGutter(elements, laid, pillsDropped) {
  const shift = (e) =>
    e.kind === "edge" ? { ...e, points: e.points.map((p) => ({ x: p.x + GUTTER, y: p.y })) } : e.kind === "band" ? e : { ...e, x: e.x + GUTTER };
  return { elements: elements.map(shift), width: laid.width + GUTTER, height: laid.height, pillsDropped };
}

// Band strips behind each row of proxies, as wide as the laid-out graph plus the label gutter.
function bands(laid, proxies) {
  const out = [];
  for (const [side, text] of BAND_TEXT) {
    const rows = proxies.filter((p) => p.id.startsWith(side)).map((p) => laid.boxes.get(p.id));
    if (rows.length === 0) continue;
    const [y0, y1] = [Math.min(...rows.map((b) => b.y)), Math.max(...rows.map((b) => b.y + b.h))];
    const lines = [text];
    const box = { x: 0, y: y0 - BAND_PAD, w: laid.width + GUTTER, h: y1 - y0 + 2 * BAND_PAD };
    out.push(element(`band:${side}`, "band", lines, box));
  }
  return out;
}

async function focusScene(nodes, spec, edges, proxies, extraOptions = {}) {
  for (const p of proxies) {
    nodes.push({ id: p.id, w: p.w, h: p.h, options: p.options });
    spec.set(p.id, { kind: "chip", lines: p.lines });
  }
  const laid = await layout(nodes, edges, { ...COMPACT, ...extraOptions });
  const elements = [];
  for (const [id, s] of spec) elements.push(element(id, s.kind, s.lines, laid.boxes.get(id)));
  const labelled = [];
  for (const e of edges) {
    const points = laid.routes.get(e.id);
    if (!points) continue;
    const edge = edgeElement(e.id, points, { sw: strokeFor(e.pairs) });
    elements.push(edge);
    if (e.pairs > 1 && (e.src.startsWith("top:") || e.dst.startsWith("bot:"))) labelled.push([edge, String(e.pairs)]);
  }
  const { pills, dropped } = placePills(elements, labelled);
  return withGutter([...bands(laid, proxies), ...elements, ...pills], laid, dropped);
}

const isProxy = (id) => /^(top|bot):/.test(id);

/**
 * Fit a focus view's edges under `budget`: the heaviest half of the budget stays as stubs
 * to the exact box; lighter stubs re-end on the focus container's border (one per proxy);
 * internal edges fill what is left, heaviest first. Returns the edges and how many were cut.
 */
function fitStubs(edges, containerId, budget) {
  const stubs = edges.filter((e) => isProxy(e.src) || isProxy(e.dst)).sort((a, b) => b.pairs - a.pairs || (a.id < b.id ? -1 : 1));
  const inner = edges.filter((e) => !stubs.includes(e));
  const exact = stubs.slice(0, Math.floor(budget / 2));
  const moved = refold(stubs.slice(exact.length), new Map(stubs.slice(exact.length).map((e) => [isProxy(e.src) ? e.dst : e.src, containerId])));
  const room = Math.max(0, budget - exact.length - moved.length);
  const keptInner = [...inner].sort((a, b) => b.pairs - a.pairs || (a.id < b.id ? -1 : 1)).slice(0, room);
  return { edges: [...exact, ...moved, ...keptInner].sort((a, b) => (a.id < b.id ? -1 : 1)), cut: inner.length - keptInner.length, rerouted: stubs.length - exact.length };
}

export { fitStubs, CAP, capProxies, containerOptions, focusEdges, focusScene, proxyNodes, refold, shortName };
