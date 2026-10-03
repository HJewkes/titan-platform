import type { GraphLayout, Point } from "./layout.js";
import { activityCategory } from "./spawn-tree.js";
import type { ActivityCategory, NodeActivity } from "./types.js";

/** The fields of a grouped chat feed entry that spark routing reads. */
export interface SparkSource {
  msgId: string;
  kind: string;
  from: string;
  at: number;
  recipients: readonly string[];
}

/**
 * The names a message travels through along tree edges, up to the lowest common
 * ancestor and back down, so no edge the spawn tree lacks is drawn. Names in
 * different trees return the pair as-is: one straight jump, honestly a jump.
 */
export function treePath(layout: GraphLayout, from: string, to: string): string[] {
  if (from === to) return [];
  if (!layout.byName.has(from) || !layout.byName.has(to)) return [];

  const fromLine = ancestry(layout, from);
  const toLine = ancestry(layout, to);
  const meetIndex = toLine.findIndex((name) => fromLine.includes(name));
  if (meetIndex === -1) return [from, to];

  const meet = toLine[meetIndex] as string;
  const up = fromLine.slice(0, fromLine.indexOf(meet) + 1);
  const down = toLine.slice(0, meetIndex).reverse();
  return [...up, ...down];
}

/** The node, then each ancestor, closest first. */
function ancestry(layout: GraphLayout, name: string): string[] {
  const line: string[] = [];
  let cursor: string | null = name;
  while (cursor !== null && layout.byName.has(cursor) && !line.includes(cursor)) {
    line.push(cursor);
    cursor = layout.byName.get(cursor)?.parent ?? null;
  }
  return line;
}

export interface SparkRoute {
  from: string;
  to: string;
  category: ActivityCategory;
  points: Point[];
}

/** One route per recipient of a send. Recipients off the graph are dropped. */
export function sparkRoutes(layout: GraphLayout, entry: SparkSource): SparkRoute[] {
  const category = activityCategory(entry.kind);
  return entry.recipients
    .map((to) => ({ to, path: treePath(layout, entry.from, to) }))
    .filter(({ path }) => path.length > 1)
    .map(({ to, path }) => ({ from: entry.from, to, category, points: path.map((name) => pointOf(layout, name)) }));
}

function pointOf(layout: GraphLayout, name: string): Point {
  const node = layout.byName.get(name);
  return { x: node?.x ?? 0, y: node?.y ?? 0 };
}

/** Position at fraction `t` of a polyline, measured by length so a spark keeps constant speed. */
export function pointAlongPolyline(points: readonly Point[], t: number): Point {
  if (points.length === 0) return { x: 0, y: 0 };
  if (points.length === 1) return points[0] as Point;

  const lengths = points.slice(1).map((point, i) => distance(points[i] as Point, point));
  const total = lengths.reduce((sum, length) => sum + length, 0);
  if (total === 0) return points[0] as Point;

  let travelled = Math.min(1, Math.max(0, t)) * total;
  for (let i = 0; i < lengths.length; i++) {
    const length = lengths[i] as number;
    if (travelled <= length || i === lengths.length - 1) {
      const ratio = length === 0 ? 0 : Math.min(1, travelled / length);
      return lerp(points[i] as Point, points[i + 1] as Point, ratio);
    }
    travelled -= length;
  }
  return points[points.length - 1] as Point;
}

function distance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function lerp(a: Point, b: Point, t: number): Point {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/** How long a spark takes to travel its route, whatever the route's length. */
export const SPARK_DURATION_MS = 1_100;

/** How long after an event a node keeps its glow. */
export const GLOW_DURATION_MS = 6_000;

export interface Spark extends SparkRoute {
  id: string;
  startedAt: number;
}

/** Sparks for entries newer than `since`, so a refetch cannot replay the feed. */
export function sparksSince(layout: GraphLayout, entries: readonly SparkSource[], since: number, now: number): Spark[] {
  return entries
    .filter((entry) => entry.at > since)
    .flatMap((entry) =>
      sparkRoutes(layout, entry).map((route, i) => ({ ...route, id: `${entry.msgId}:${route.to}:${i}`, startedAt: now })),
    );
}

export function liveSparks(sparks: readonly Spark[], now: number): Spark[] {
  return sparks.filter((spark) => now - spark.startedAt < SPARK_DURATION_MS);
}

/** 1 at the instant of the event, 0 once the glow has decayed. */
export function glowStrength(activity: NodeActivity | undefined, now: number): number {
  if (!activity) return 0;
  const age = now - activity.at;
  if (age < 0) return 1;
  return Math.max(0, 1 - age / GLOW_DURATION_MS);
}
