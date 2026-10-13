// The constraint rules a frame must pass before it may be rendered. Each check returns
// { ok, value, threshold, detail }: what was measured, what the config allows, and where it
// failed. Thresholds come from the derived limits (config.mjs), never from constants here.
import { edgeCrosses, hit, labelEdgeHits, onBorder, textRects } from "./labels.mjs";

const BOX_KINDS = new Set(["box", "container", "tile", "chip"]);
const LEAF_KINDS = new Set(["box", "tile", "chip"]);
const boxes = (frame) => frame.elements.filter((e) => BOX_KINDS.has(e.kind));
const edges = (frame) => frame.elements.filter((e) => e.kind === "edge");
const labelled = (frame) => frame.elements.filter((e) => e.lines);
const result = (ok, value, threshold, detail = undefined) => ({ ok, value, threshold, ...(detail === undefined ? {} : { detail }) });

function inside(inner, outer, tol) {
  return inner.x >= outer.x - tol && inner.y >= outer.y - tol && inner.x + inner.w <= outer.x + outer.w + tol && inner.y + inner.h <= outer.y + outer.h + tol;
}

function labelFloor(frame, limits) {
  const sizes = labelled(frame).map((e) => e.fs);
  const min = sizes.length ? Math.min(...sizes) : null;
  return result(min !== null && min >= limits.labelPx - 0.01, min, limits.labelPx, `fit ${frame.fit}`);
}

function labelOverlap(frame) {
  const rects = labelled(frame).flatMap((e) => textRects(e).map((r) => ({ ...r, id: e.id })));
  let n = 0;
  for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) if (rects[i].id !== rects[j].id && hit(rects[i], rects[j], 0)) n++;
  return result(n === 0, n, 0);
}

function edgeThroughLabel(frame) {
  const n = labelEdgeHits(frame.elements);
  const hitIds = labelled(frame).filter((e) => textRects(e).some((r) => edgeCrosses(edges(frame), r, e.kind === "elabel" ? e.id.replace(/#n$/, "") : null))).map((e) => e.id);
  return result(n === 0, n, 0, hitIds);
}

// A pill must sit wholly inside or wholly outside every container, clear of every leaf box
// by the minimum gap, and on no edge but its own.
function pillsClear(frame, limits) {
  const gap = limits.metrics.minGap;
  const containers = boxes(frame).filter((b) => b.kind === "container");
  const bad = [];
  for (const pill of frame.elements.filter((e) => e.kind === "elabel")) {
    const own = pill.id.replace(/#n$/, "");
    const touchesLeaf = boxes(frame).some((b) => LEAF_KINDS.has(b.kind) && hit(pill, b, gap));
    if (touchesLeaf || onBorder(pill, containers, gap) || edgeCrosses(edges(frame), pill, own, gap)) bad.push(pill.id);
  }
  return result(bad.length === 0, bad.length, 0, bad);
}

function containment(frame) {
  const byId = new Map(frame.elements.map((e) => [e.id, e]));
  const bad = frame.elements.filter((e) => e.parent && byId.has(e.parent) && !inside(e, byId.get(e.parent), 0.5)).map((e) => e.id);
  return result(bad.length === 0, bad.length, 0, bad);
}

function safeArea(frame, limits) {
  const c = { x: limits.content.x, y: limits.content.y, w: limits.content.width, h: limits.content.height };
  const outBoxes = frame.elements.filter((e) => e.kind !== "edge" && !inside(e, c, 1)).map((e) => e.id);
  const outEdges = edges(frame).filter((e) => e.points.some((p) => !inside({ x: p.x, y: p.y, w: 0, h: 0 }, c, 1))).map((e) => e.id);
  const bad = [...outBoxes, ...outEdges];
  return result(bad.length === 0, bad.length, 0, bad);
}

function minSpacing(frame, limits) {
  const gap = limits.metrics.minGap;
  const items = boxes(frame);
  const bad = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const [a, b] = [items[i], items[j]];
      if (inside(a, b, 0.5) || inside(b, a, 0.5)) continue;
      if (hit(a, b, gap)) bad.push(`${a.id}|${b.id}`);
    }
  }
  return result(bad.length === 0, bad.length, gap, bad);
}

// Proper crossings of a horizontal and a vertical segment from different edges, away from
// either segment's ends (edges legitimately meet at shared ports).
function crossing(a0, a1, b0, b1) {
  const horizontal = (p, q) => Math.abs(p.y - q.y) < 0.5 && Math.abs(p.x - q.x) >= 1;
  const vertical = (p, q) => Math.abs(p.x - q.x) < 0.5 && Math.abs(p.y - q.y) >= 1;
  if (horizontal(a0, a1) && vertical(b0, b1)) return crossing(b0, b1, a0, a1);
  if (!(vertical(a0, a1) && horizontal(b0, b1))) return false;
  const [x, y] = [a0.x, b0.y];
  const within = (v, p, q) => v > Math.min(p, q) + 1 && v < Math.max(p, q) - 1;
  return within(x, b0.x, b1.x) && within(y, a0.y, a1.y);
}

/** Proper crossings between the orthogonal routes of distinct edges. */
export function crossingCount(elements) {
  const list = elements.filter((e) => e.kind === "edge");
  let n = 0;
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const [a, b] = [list[i].points, list[j].points];
      for (let s = 1; s < a.length; s++) for (let t = 1; t < b.length; t++) if (crossing(a[s - 1], a[s], b[t - 1], b[t])) n++;
    }
  }
  return n;
}

/** The crossing budget is a fraction of the drawn edges (config), so it scales with the edge cap. */
export function crossingBudget(elements, limits) {
  return Math.floor(limits.caps.crossingsPerEdge * elements.filter((e) => e.kind === "edge").length);
}

function edgeCrossings(frame, limits) {
  const n = crossingCount(frame.elements);
  return result(n <= crossingBudget(frame.elements, limits), n, crossingBudget(frame.elements, limits));
}

function elisionsCounted(frame) {
  const byId = new Map(frame.elements.map((e) => [e.id, e]));
  const list = frame.elisions ?? [];
  const bad = list.filter((el) => !byId.get(el.in)?.lines?.some((l) => l.includes(String(el.hidden)))).map((el) => `${el.what} ${el.hidden} in ${el.in}`);
  return result(bad.length === 0, bad.length, 0, bad);
}

function caps(frame, limits) {
  const value = {
    boxes: boxes(frame).length,
    edges: edges(frame).length,
    labels: labelled(frame).reduce((n, e) => n + e.lines.length, 0),
    groups: frame.elements.filter((e) => BOX_KINDS.has(e.kind) && e.kind !== "tile" && !e.parent).length,
  };
  const c = limits.caps;
  const countOk = c.unit === "labels" ? value.labels <= c.labels : value.boxes <= c.boxes;
  return result(countOk && value.edges <= c.edges && value.groups <= c.groups, value, { boxes: c.boxes, labels: c.labels, edges: c.edges, groups: c.groups, unit: c.unit });
}

function stroke(frame, limits) {
  const widths = edges(frame).map((e) => e.sw);
  const min = widths.length ? Math.min(...widths) : null;
  return result(min === null || min >= limits.minStrokePx - 0.01, min, limits.minStrokePx);
}

const centre = (e) => ({ x: e.x + e.w / 2, y: e.y + e.h / 2 });

/**
 * How much a step disturbs the mental map: for boxes in both frames, the mean centre
 * displacement and the share of box pairs whose left/right or above/below order flips.
 */
export function mentalMap(from, to) {
  const b = new Map(to.elements.filter((e) => e.kind !== "edge" && e.kind !== "elabel").map((e) => [e.id, e]));
  const both = from.elements.filter((e) => b.has(e.id) && e.kind !== "edge" && e.kind !== "elabel");
  const moves = both.map((e) => Math.hypot(centre(e).x - centre(b.get(e.id)).x, centre(e).y - centre(b.get(e.id)).y));
  let [pairs, flips] = [0, 0];
  for (let i = 0; i < both.length; i++) {
    for (let j = i + 1; j < both.length; j++) {
      const [a0, b0, a1, b1] = [centre(both[i]), centre(both[j]), centre(b.get(both[i].id)), centre(b.get(both[j].id))];
      const flipped = (u, v) => Math.abs(u) > 4 && Math.abs(v) > 4 && Math.sign(u) !== Math.sign(v);
      pairs++;
      if (flipped(b0.x - a0.x, b1.x - a1.x) || flipped(b0.y - a0.y, b1.y - a1.y)) flips++;
    }
  }
  const mean = moves.length ? moves.reduce((s, m) => s + m, 0) / moves.length : 0;
  return { persisting: both.length, meanMovePx: Math.round(mean), orderFlips: `${flips}/${pairs}`, flipShare: pairs ? flips / pairs : 0 };
}

function stability(frame, limits, prev) {
  if (!prev) return result(true, null, null, "first step of the ladder");
  const m = mentalMap(prev, frame);
  const maxMove = limits.cfg.stability.maxMoveFraction * limits.frame.height;
  const maxFlip = limits.cfg.stability.maxOrderFlipFraction;
  return result(m.meanMovePx <= maxMove && m.flipShare <= maxFlip, m, { meanMovePx: Math.round(maxMove), flipShare: maxFlip }, `from ${prev.name}`);
}

export const RULES = { labelFloor, labelOverlap, edgeThroughLabel, pillsClear, containment, safeArea, minSpacing, edgeCrossings, elisionsCounted, caps, stroke, stability };

/** Every rule on one frame (frame px elements); `prev` is the previous ladder step, if any. */
export function checkFrame(frame, limits, prev = null) {
  const rules = {};
  for (const [name, fn] of Object.entries(RULES)) rules[name] = fn(frame, limits, prev);
  return { rules, violated: Object.keys(rules).filter((n) => !rules[n].ok) };
}
