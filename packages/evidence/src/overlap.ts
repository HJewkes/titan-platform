import type { LineRange } from "./citation.js";

/** True when two ranges share a path and at least one line. Touching ranges (10-12, 12-14) overlap. */
export function rangesOverlap(a: LineRange, b: LineRange): boolean {
  return a.path === b.path && a.lineStart <= b.lineEnd && b.lineStart <= a.lineEnd;
}

export interface GroupOptions<T> {
  /** An extra condition two items must meet, beyond an overlapping range, to join one group. */
  related?: (a: T, b: T) => boolean;
}

function linked<T>(a: T, b: T, rangesOf: (item: T) => readonly LineRange[], related?: (a: T, b: T) => boolean): boolean {
  const overlaps = rangesOf(a).some((x) => rangesOf(b).some((y) => rangesOverlap(x, y)));
  return overlaps && (related ? related(a, b) : true);
}

function find(parent: number[], i: number): number {
  let node = i;
  let up = parent[node] ?? node;
  while (up !== node) {
    const grand = parent[up] ?? up;
    parent[node] = grand;
    node = grand;
    up = parent[node] ?? node;
  }
  return node;
}

/**
 * Groups items whose ranges overlap, transitively: a bridging item joins two groups into one.
 * Groups and their members keep input order.
 */
export function groupByOverlap<T>(items: readonly T[], rangesOf: (item: T) => readonly LineRange[], options: GroupOptions<T> = {}): T[][] {
  const parent = items.map((_, i) => i);
  items.forEach((a, i) => {
    items.slice(i + 1).forEach((b, offset) => {
      const j = i + 1 + offset;
      if (linked(a, b, rangesOf, options.related)) parent[find(parent, j)] = find(parent, i);
    });
  });
  const groups = new Map<number, T[]>();
  items.forEach((item, i) => {
    const root = find(parent, i);
    groups.set(root, [...(groups.get(root) ?? []), item]);
  });
  return [...groups.values()];
}
