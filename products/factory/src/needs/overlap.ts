import { mergeByKeys, type OwnerItem } from "@titan-design/owner-queue";

const PR = /^pr:(?:[\w.-]+\/)?([\w.-]+)#(\d+)(?:@.*)?$/i;

export interface OverlapEntry {
  id: string;
  system: string;
}

/** One PR, task, run or gate that items from two or more sources name. */
export interface Overlap {
  subject: string;
  entries: OverlapEntry[];
  /** mergeByKeys joined every entry into one item; false means the owner still sees it more than once. */
  merged: boolean;
}

/**
 * A key loosened to what it is about: a PR by repo name and number, whatever owner or head the source wrote.
 * Merging needs the exact key; the report shows the near misses merging leaves apart.
 */
export function subjectOf(key: string): string | undefined {
  const pr = PR.exec(key);
  if (pr) return `pr:${pr[1]!.toLowerCase()}#${pr[2]}`;
  if (/^run:/i.test(key)) return key.toLowerCase();
  return /^(task|gate):\S+$/.test(key) ? key : undefined;
}

const sourceKey = (item: OwnerItem): string => `${item.sources[0]!.system}\u0000${item.sources[0]!.ref}`;

function mergedGroups(items: readonly OwnerItem[]): Map<string, number> {
  const group = new Map<string, number>();
  mergeByKeys(items).forEach((merged, index) => {
    for (const source of merged.sources) group.set(`${source.system}\u0000${source.ref}`, index);
  });
  return group;
}

function bySubject(items: readonly OwnerItem[]): Map<string, OwnerItem[]> {
  const named = new Map<string, OwnerItem[]>();
  for (const item of items) {
    const subjects = new Set(item.keys.map(subjectOf).filter((subject): subject is string => subject !== undefined));
    for (const subject of subjects) named.set(subject, [...(named.get(subject) ?? []), item]);
  }
  return named;
}

/** Subjects named by more than one source system, sorted, with whether merge-by-keys already folded them. */
export function overlapReport(items: readonly OwnerItem[]): Overlap[] {
  const group = mergedGroups(items);
  return [...bySubject(items)]
    .filter(([, named]) => new Set(named.map((item) => item.sources[0]!.system)).size > 1)
    .map(([subject, named]) => ({
      subject,
      entries: named.map((item) => ({ id: item.id, system: item.sources[0]!.system })),
      merged: new Set(named.map((item) => group.get(sourceKey(item)))).size === 1,
    }))
    .sort((a, b) => a.subject.localeCompare(b.subject));
}

export function renderOverlapReport(overlaps: readonly Overlap[]): string {
  const lines = overlaps.map(({ subject, entries, merged }) => {
    const named = entries.map((entry) => `${entry.system} ${entry.id}`).join(", ");
    return `${subject}: ${named} (${merged ? "merged" : "not merged: no shared exact key"})`;
  });
  const folded = overlaps.filter((overlap) => overlap.merged).length;
  return [`${overlaps.length} overlaps, ${folded} merged, ${overlaps.length - folded} shown more than once`, ...lines].join("\n");
}
