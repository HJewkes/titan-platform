import type { NodeSize } from "./types.js";

/** An axis-aligned box by its top-left corner, in layout units. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SceneRect {
  id: string;
  rect: Rect;
}

/** The geometry a pill must respect; every rect is in the same layout frame. */
export interface PillScene {
  /** The visible frame. Pills stay inside it and above its keep-out band. */
  frame: Rect;
  /** Boxes a pin can anchor to, by id. */
  anchors: readonly SceneRect[];
  /** Rects no pill may touch: box labels, edge labels, a legend. */
  obstacles: readonly SceneRect[];
}

/** One pill to place beside the anchor box it names. Lower `rank` places first; ties break on id. */
export interface PinSpec extends NodeSize {
  id: string;
  anchor: string;
  rank?: number;
}

export interface PillConfig {
  /** Clear space between a pill and its anchor, an obstacle or another pill. */
  gap: number;
  /** Fraction of the frame's height where the keep-out band starts, e.g. 0.83 above a caption band. */
  keepOut: number;
  /** A pill sits at most this many pill heights from its anchor. Default 3. */
  reachSlots?: number;
}

export interface PlacedPill {
  id: string;
  anchor: string;
  rect: Rect;
  /** The candidate that won, e.g. `below0`, `above1R0.5`, `side0L`. */
  candidate: string;
}

export interface DroppedPill {
  id: string;
  reason: "no-anchor" | "no-spot";
}

/** Placed and dropped pills, each in placement order. */
export interface PillPlacement {
  placed: PlacedPill[];
  dropped: DroppedPill[];
}

interface Candidate {
  rect: Rect;
  tag: string;
}

interface Placer {
  safe: Rect;
  gap: number;
  reachSlots: number;
  taken: Rect[];
}

const COLUMN_SLOTS = 4;
const SIDE_SLOTS = 3;
const SHIFTS = [0.25, 0.5, 0.75, 1] as const;
// A shifted pill keeps this much width under its anchor, so it still reads as that box's pill.
const MIN_SHARED_WIDTH = 48;
const DIRECTIONS = [
  [1, "below"],
  [-1, "above"],
] as const;

const half = (v: number): number => Math.round(v * 2) / 2;
const centredAt = (cx: number, cy: number, size: NodeSize): Rect => ({
  x: half(cx - size.width / 2),
  y: half(cy - size.height / 2),
  width: half(size.width),
  height: half(size.height),
});
const grow = (r: Rect, by: number): Rect => ({ x: r.x - by, y: r.y - by, width: r.width + 2 * by, height: r.height + 2 * by });
const overlaps = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const inside = (r: Rect, s: Rect): boolean =>
  r.x >= s.x && r.y >= s.y && r.x + r.width <= s.x + s.width && r.y + r.height <= s.y + s.height;

function distance(a: Rect, b: Rect): number {
  const dx = Math.max(0, a.x - (b.x + b.width), b.x - (a.x + a.width));
  const dy = Math.max(0, a.y - (b.y + b.height), b.y - (a.y + a.height));
  return Math.hypot(dx, dy);
}

function rowCentreY(owner: Rect, size: NodeSize, gap: number, dir: 1 | -1, slot: number): number {
  const step = slot * (size.height + gap);
  return dir > 0 ? owner.y + owner.height + gap + size.height / 2 + step : owner.y - gap - size.height / 2 - step;
}

/** Spots under, then over, the anchor: centred columns first, then the same rows shifted, then beside it. */
function pillCandidates(owner: Rect, size: NodeSize, gap: number): Candidate[] {
  const cx = owner.x + owner.width / 2;
  const maxShift = Math.max(0, size.width / 2 + owner.width / 2 - MIN_SHARED_WIDTH);
  const rows = DIRECTIONS.flatMap(([dir, name]) =>
    Array.from({ length: COLUMN_SLOTS }, (_, slot) => ({ cy: rowCentreY(owner, size, gap, dir, slot), tag: `${name}${slot}` })),
  );
  const centred = rows.map(({ cy, tag }) => ({ rect: centredAt(cx, cy, size), tag }));
  const shifted = maxShift === 0 ? [] : rows.flatMap(({ cy, tag }) =>
    SHIFTS.flatMap((f) => ([1, -1] as const).map((d) => ({
      rect: centredAt(cx + d * f * maxShift, cy, size),
      tag: `${tag}${d > 0 ? "R" : "L"}${f}`,
    }))),
  );
  return [...centred, ...shifted, ...besideCandidates(owner, size, gap)];
}

function besideCandidates(owner: Rect, size: NodeSize, gap: number): Candidate[] {
  const cx = owner.x + owner.width / 2;
  return Array.from({ length: SIDE_SLOTS }, (_, slot) => slot).flatMap((slot) =>
    ([1, -1] as const).map((d) => ({
      rect: centredAt(cx + d * (owner.width / 2 + gap + size.width / 2), owner.y + owner.height - size.height / 2 + slot * (size.height + gap), size),
      tag: `side${slot}${d > 0 ? "R" : "L"}`,
    })),
  );
}

function fits(rect: Rect, owner: Rect, placer: Placer): boolean {
  const { safe, gap, reachSlots, taken } = placer;
  if (!inside(rect, safe)) return false;
  const clear = grow(rect, gap);
  if (taken.some((r) => overlaps(clear, r))) return false;
  return distance(rect, owner) <= reachSlots * (rect.height + gap) + gap;
}

const byRankThenId = (a: PinSpec, b: PinSpec): number =>
  (a.rank ?? 0) - (b.rank ?? 0) || a.id.localeCompare(b.id) || a.anchor.localeCompare(b.anchor);

/**
 * Places each pin's pill beside its anchor box: inside the frame above its keep-out band, clear of
 * every obstacle and every pill placed before it, and within reach of the anchor. Greedy in rank
 * order, so the input order of `pins` does not matter. A pill with no clear spot is dropped, never
 * drawn over something; a painter falls back for it.
 */
export function placePills(scene: PillScene, pins: readonly PinSpec[], config: PillConfig): PillPlacement {
  const anchors = new Map(scene.anchors.map((a) => [a.id, a.rect]));
  const { frame } = scene;
  const placer: Placer = {
    safe: { x: frame.x, y: frame.y, width: frame.width, height: frame.height * config.keepOut },
    gap: config.gap,
    reachSlots: config.reachSlots ?? 3,
    taken: scene.obstacles.map((o) => o.rect),
  };
  const result: PillPlacement = { placed: [], dropped: [] };
  for (const pin of [...pins].sort(byRankThenId)) {
    const owner = anchors.get(pin.anchor);
    const hit = owner && pillCandidates(owner, pin, placer.gap).find((c) => fits(c.rect, owner, placer));
    if (!hit) {
      result.dropped.push({ id: pin.id, reason: owner ? "no-spot" : "no-anchor" });
      continue;
    }
    placer.taken.push(hit.rect);
    result.placed.push({ id: pin.id, anchor: pin.anchor, rect: hit.rect, candidate: hit.tag });
  }
  return result;
}
