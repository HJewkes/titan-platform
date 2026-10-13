// Scene model shared by every design: boxes and edges in layout units where one unit is one
// screen px at scale 1, so a 24-unit label is a 24 px label when the scene fits unscaled.
export const FONT = 24;
export const CHAR = 0.6 * FONT;
export const LINE = 30;
export const PAD = 14;
export const CONTAINER_TOP = PAD * 2 + LINE;
export const FRAME = { width: 1920, height: 1080, content: { x: 24, y: 96, width: 1872, height: 948 } };

/** Size of a box holding `lines` of label text plus padding. */
export function boxSize(lines, minWidth = 0) {
  const longest = Math.max(...lines.map((l) => l.length));
  return { w: Math.max(minWidth, Math.ceil(longest * CHAR + 2 * PAD)), h: Math.ceil(lines.length * LINE + 2 * PAD - 6) };
}

/** A scene element from an ELK box: kind is box | container | tile | chip | band. */
export function element(id, kind, lines, box, extra = {}) {
  return { id, kind, lines, x: box.x, y: box.y, w: box.w, h: box.h, ...extra };
}

export function edgeElement(id, points, extra = {}) {
  return { id, kind: "edge", points, ...extra };
}

export function strokeFor(weight) {
  return Math.min(9, 1.5 + Math.log2(1 + weight));
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

/** Elements in screen px under transform `t`; `fs` is each label's font size in screen px. */
export function toScreen(elements, t) {
  return elements.map((e) => {
    if (e.kind === "edge") return { ...e, points: e.points.map((p) => mapPoint(p, t)), sw: (e.sw ?? 2) * Math.min(1, t.s * 1.5) };
    const p = mapPoint(e, t);
    return { ...e, x: p.x, y: p.y, w: +(e.w * t.s).toFixed(1), h: +(e.h * t.s).toFixed(1), fs: +(FONT * t.s).toFixed(2) };
  });
}

/** A camera that makes `rect` (screen px) fill the content area. */
export function cameraOnto(rect) {
  const c = FRAME.content;
  const s = Math.min(c.width / rect.w, c.height / rect.h);
  return { s, tx: c.x + (c.width - rect.w * s) / 2 - rect.x * s, ty: c.y + (c.height - rect.h * s) / 2 - rect.y * s };
}

/** Keep at most `budget` edges, lowest `rank` first, then heaviest; returns what was dropped per end. */
export function withinBudget(edges, budget, rank) {
  const sorted = [...edges].sort((a, b) => rank(a) - rank(b) || b.pairs - a.pairs || (a.id < b.id ? -1 : 1));
  const keep = new Set(sorted.slice(0, budget).map((e) => e.id));
  return { kept: edges.filter((e) => keep.has(e.id)), dropped: sorted.slice(budget) };
}
