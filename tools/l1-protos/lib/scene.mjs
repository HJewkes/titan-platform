// Scene model shared by every design: boxes and edges in layout units where one unit is one
// frame px at scale 1, so a 40-unit label is a 40 px label when the scene fits unscaled.
// Every px value here is derived from frame-config.json (see config.mjs): the label floor from
// the frame and the font's x-height, box padding, line pitch, glyph width and gaps from em
// fractions of that floor. Nothing is a hand constant.
import { currentLimits } from "./config.mjs";

export const LIMITS = currentLimits();
const M = LIMITS.metrics;
export const FONT = M.font;
export const CHAR = M.char;
export const LINE = M.line;
export const PAD = M.pad;
export const CONTAINER_TOP = M.containerTop;
export const MIN_GAP = M.minGap;
export const FRAME = { width: LIMITS.frame.width, height: LIMITS.frame.height, content: LIMITS.content };
const px = (v) => String(Math.round(v));

/** ELK spacing options in px, from the em fractions in config. */
export const SPACING = {
  overview: { "elk.layered.spacing.nodeNodeBetweenLayers": px(M.layerGapOverview), "elk.spacing.nodeNode": px(M.boxGap) },
  compact: { "elk.layered.spacing.nodeNodeBetweenLayers": px(M.layerGap), "elk.spacing.nodeNode": px(M.boxGap * 0.78), "elk.layered.spacing.edgeNodeBetweenLayers": px(M.edgeNode * 0.78) },
  edges: { "elk.layered.spacing.edgeNodeBetweenLayers": px(M.edgeNode), "elk.spacing.edgeNode": px(M.edgeNode), "elk.spacing.edgeEdge": px(M.edgeGap) },
};

/** Size of a box holding `lines` of label text plus padding. */
export function boxSize(lines, minWidth = 0) {
  const longest = Math.max(...lines.map((l) => l.length));
  return { w: Math.max(minWidth, Math.ceil(longest * CHAR + 2 * PAD)), h: Math.ceil(lines.length * LINE + 2 * PAD - 0.25 * FONT) };
}

/** A scene element from an ELK box: kind is box | container | tile | chip | band. */
export function element(id, kind, lines, box, extra = {}) {
  return { id, kind, lines, x: box.x, y: box.y, w: box.w, h: box.h, ...extra };
}

export function edgeElement(id, points, extra = {}) {
  return { id, kind: "edge", points, ...extra };
}

// Stroke grows with the log of the edge weight and with the label size, never under the
// viewer-side minimum.
export function strokeFor(weight) {
  return Math.max(LIMITS.minStrokePx, Math.min(9, 1.5 + Math.log2(1 + weight)) * (FONT / 24));
}

/** Fit a scene's extent into the frame's content area: never scaled up, centred. */
export function fitTransform(width, height) {
  const c = FRAME.content;
  const s = Math.min(1, c.width / width, c.height / height);
  return { s, tx: c.x + (c.width - width * s) / 2, ty: c.y + (c.height - height * s) / 2 };
}

function mapPoint(p, t) {
  return { x: +(p.x * t.s + t.tx).toFixed(1), y: +(p.y * t.s + t.ty).toFixed(1) };
}

/** Elements in frame px under transform `t`; `fs` is each label's font size in frame px. */
export function toScreen(elements, t) {
  return elements.map((e) => {
    if (e.kind === "edge") return { ...e, points: e.points.map((p) => mapPoint(p, t)), sw: +((e.sw ?? 2) * Math.min(1, t.s * 1.5)).toFixed(2) };
    const p = mapPoint(e, t);
    const label = e.ldx || e.ldy ? { ldx: +((e.ldx ?? 0) * t.s).toFixed(1), ldy: +((e.ldy ?? 0) * t.s).toFixed(1) } : {};
    return { ...e, x: p.x, y: p.y, w: +(e.w * t.s).toFixed(1), h: +(e.h * t.s).toFixed(1), fs: +(FONT * t.s).toFixed(2), ...label };
  });
}

/** A camera that makes `rect` (frame px) fill `c`, by default the content area. */
export function cameraOnto(rect, c = FRAME.content) {
  const s = Math.min(c.width / rect.w, c.height / rect.h);
  return { s, tx: c.x + (c.width - rect.w * s) / 2 - rect.x * s, ty: c.y + (c.height - rect.h * s) / 2 - rect.y * s };
}

/** Keep at most `budget` edges, lowest `rank` first, then heaviest; returns what was dropped per end. */
export function withinBudget(edges, budget, rank) {
  const sorted = [...edges].sort((a, b) => rank(a) - rank(b) || b.pairs - a.pairs || (a.id < b.id ? -1 : 1));
  const keep = new Set(sorted.slice(0, budget).map((e) => e.id));
  return { kept: edges.filter((e) => keep.has(e.id)), dropped: sorted.slice(budget) };
}
