// Edge count pills placed where they collide with nothing, and the label/edge crossing count.
import { CHAR, LINE, PAD, boxSize, element } from "./scene.mjs";

const LEAF_KINDS = new Set(["box", "tile", "chip"]);

function hit(a, b, gap = 2) {
  return a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;
}

/** Rectangles of every text line of a box-like element. */
export function textRects(e) {
  const s = (e.fs ?? 24) / 24;
  return e.lines.map((line, i) => ({ x: e.x + PAD * s, y: e.y + PAD * s + i * LINE * s, w: line.length * CHAR * s, h: LINE * s - 4 * s }));
}

function candidates(points, size) {
  const out = [];
  for (let i = 1; i < points.length; i++) {
    const [a, b] = [points[i - 1], points[i]];
    const len = Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
    for (const t of [0.5, 0.3, 0.7, 0.15, 0.85]) {
      const [cx, cy] = [a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t];
      out.push({ len, rect: { x: cx - size.w / 2, y: cy - size.h / 2, w: size.w, h: size.h } });
    }
  }
  return out.sort((p, q) => q.len - p.len).map((c) => c.rect);
}

/**
 * Pills for `labelled` ([edge element, text]) placed greedily, heaviest first, at the first
 * candidate on the edge that overlaps no box, no label line and no pill already placed.
 * Returns the pills and how many edges got none.
 */
export function placePills(elements, labelled) {
  const blocked = [
    ...elements.filter((e) => LEAF_KINDS.has(e.kind)),
    ...elements.filter((e) => e.lines && !LEAF_KINDS.has(e.kind)).flatMap(textRects),
  ];
  const pills = [];
  let dropped = 0;
  for (const [edge, text] of [...labelled].sort((a, b) => b[0].sw - a[0].sw || (a[0].id < b[0].id ? -1 : 1))) {
    const size = boxSize([text]);
    const spot = candidates(edge.points, size).find((r) => !blocked.some((b) => hit(r, b)));
    if (!spot) {
      dropped++;
      continue;
    }
    const pill = element(`${edge.id}#n`, "elabel", [text], spot);
    pills.push(pill);
    blocked.push(spot);
  }
  return { pills, dropped };
}

function segmentHitsRect(a, b, r) {
  const [x0, x1, y0, y1] = [Math.min(a.x, b.x), Math.max(a.x, b.x), Math.min(a.y, b.y), Math.max(a.y, b.y)];
  return x0 <= r.x + r.w && x1 >= r.x && y0 <= r.y + r.h && y1 >= r.y;
}

/** Label lines (boxes, containers, bands, pills) that an edge segment passes through. */
export function labelEdgeHits(elements) {
  const edges = elements.filter((e) => e.kind === "edge");
  let hits = 0;
  for (const e of elements.filter((x) => x.lines)) {
    const own = e.kind === "elabel" ? e.id.replace(/#n$/, "") : null;
    for (const r of textRects(e)) {
      const crossed = edges.some((g) => g.id !== own && g.points.some((p, i) => i > 0 && segmentHitsRect(g.points[i - 1], p, r)));
      if (crossed) hits++;
    }
  }
  return hits;
}
