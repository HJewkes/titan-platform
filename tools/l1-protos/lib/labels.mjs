// Edge count pills placed where they collide with nothing, container headers moved out of the
// way of edges, and the label/edge crossing count. All placement is a deterministic scan over
// fixed candidate lists, so the same layout always gets the same labels.
import { CHAR, FONT, LINE, MIN_GAP, MONO_CHAR, PAD, boxSize, charFor, element } from "./scene.mjs";

const LEAF_KINDS = new Set(["box", "tile", "chip"]);

export function hit(a, b, gap = MIN_GAP) {
  return a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;
}

/** Rectangles of every text line of a box-like element, honouring a moved label (ldx, ldy). */
export function textRects(e) {
  const s = (e.fs ?? FONT) / FONT;
  const [dx, dy] = [e.ldx ?? 0, e.ldy ?? 0];
  const char = charFor(e.id, e.kind);
  return e.lines.map((line, i) => ({ x: e.x + PAD * s + dx, y: e.y + PAD * s + i * LINE * s + dy, w: line.length * char * s, h: LINE * s - 4 * s * (FONT / 24) }));
}

const PILL_T = [0.5, 0.3, 0.7, 0.2, 0.8, 0.1, 0.9];

// Pill spots along each segment, longest segment first: centred on the line, then beside it
// on either side (perpendicular to the segment), so a pill can sit next to a crowded edge.
function candidates(points, size) {
  const out = [];
  for (let i = 1; i < points.length; i++) {
    const [a, b] = [points[i - 1], points[i]];
    const len = Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
    const vertical = Math.abs(b.x - a.x) < Math.abs(b.y - a.y);
    const side = vertical ? { x: size.w / 2 + MIN_GAP, y: 0 } : { x: 0, y: size.h / 2 + MIN_GAP };
    for (const t of PILL_T) {
      const [cx, cy] = [a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t];
      for (const k of [0, 1, -1]) out.push({ len, order: PILL_T.indexOf(t) * 3 + Math.abs(k) + (k < 0 ? 0.5 : 0), rect: { x: cx - size.w / 2 + k * side.x, y: cy - size.h / 2 + k * side.y, w: size.w, h: size.h } });
    }
  }
  return out.sort((p, q) => q.len - p.len || p.order - q.order).map((c) => c.rect);
}

export function segmentHitsRect(a, b, r, gap = 0) {
  const [x0, x1, y0, y1] = [Math.min(a.x, b.x), Math.max(a.x, b.x), Math.min(a.y, b.y), Math.max(a.y, b.y)];
  return x0 <= r.x + r.w + gap && x1 >= r.x - gap && y0 <= r.y + r.h + gap && y1 >= r.y - gap;
}

/** Whether any edge other than `own` runs through `r` (grown by `gap`). */
export function edgeCrosses(edges, r, own = null, gap = 0) {
  return edges.some((g) => g.id !== own && g.points.some((p, i) => i > 0 && segmentHitsRect(g.points[i - 1], p, r, gap)));
}

/**
 * Pills for `labelled` ([edge element, text]) placed greedily, heaviest first, at the first
 * candidate on the edge that overlaps no box, no label line, no pill already placed and no
 * other edge. Returns the pills and how many edges got none.
 */
/** Whether `r` straddles a container's border (it must sit wholly inside or wholly outside). */
export function onBorder(r, containers, gap = MIN_GAP) {
  const within = (c) => r.x >= c.x + gap && r.y >= c.y + gap && r.x + r.w <= c.x + c.w - gap && r.y + r.h <= c.y + c.h - gap;
  return containers.some((c) => hit(r, c, gap) && !within(c));
}

export function placePills(elements, labelled) {
  const edges = elements.filter((e) => e.kind === "edge");
  const containers = elements.filter((e) => e.kind === "container");
  const blocked = [
    ...elements.filter((e) => LEAF_KINDS.has(e.kind)),
    ...elements.filter((e) => e.lines && !LEAF_KINDS.has(e.kind)).flatMap(textRects),
  ];
  const pills = [];
  let dropped = 0;
  for (const [edge, text] of [...labelled].sort((a, b) => b[0].sw - a[0].sw || (a[0].id < b[0].id ? -1 : 1))) {
    const size = boxSize([text], 0, MONO_CHAR);
    const clear = (r) => !blocked.some((b) => hit(r, b)) && !onBorder(r, containers) && !edgeCrosses(edges, r, edge.id, MIN_GAP);
    const spot = candidates(edge.points, size).find(clear);
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

// Header offsets to try, in order: slide right along the container's top band, then sit just
// above the container. Each is checked against every edge and every other box.
function headerOffsets(e) {
  const width = Math.max(...e.lines.map((l) => l.length)) * CHAR;
  const out = [];
  for (let dx = CHAR; e.x + PAD + dx + width <= e.x + e.w - PAD; dx += CHAR) out.push({ ldx: dx, ldy: 0 });
  out.push({ ldx: 0, ldy: -(e.lines.length * LINE + PAD) });
  return out;
}

/**
 * Move each container's header text to the first spot no edge crosses and no box touches,
 * mutating the elements in place. Returns how many moved and how many could not be cleared.
 */
export function placeHeaders(elements) {
  const edges = elements.filter((e) => e.kind === "edge");
  const boxes = elements.filter((e) => e.kind !== "edge" && e.kind !== "band");
  const clear = (c, rects) => !edgeCrosses(edges, c, null, MIN_GAP) && !boxes.some((b) => b !== rects.owner && hit(c, b));
  let [moved, unresolved] = [0, 0];
  for (const e of elements.filter((x) => x.kind === "container")) {
    const crossed = (el) => textRects(el).some((r) => !clear(r, { owner: e }));
    if (!crossed(e)) continue;
    const spot = headerOffsets(e).find((o) => !crossed({ ...e, ...o }));
    if (spot) {
      Object.assign(e, spot);
      moved++;
    } else unresolved++;
  }
  return { moved, unresolved };
}

/** Label lines (boxes, containers, bands, pills) that an edge segment passes through. */
export function labelEdgeHits(elements) {
  const edges = elements.filter((e) => e.kind === "edge");
  let hits = 0;
  for (const e of elements.filter((x) => x.lines)) {
    const own = e.kind === "elabel" ? e.id.replace(/#n$/, "") : null;
    for (const r of textRects(e)) if (edgeCrosses(edges, r, own)) hits++;
  }
  return hits;
}
