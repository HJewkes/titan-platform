import type { OwnerItem, SourceRef } from "./schema.js";

const PR_KEY = /^pr:([\w.-]+\/[\w.-]+#\d+)@([0-9a-f]{7,64})$/;
const ID_KEY = /^(task|gate|run):\S+$/;

/** A key merges only in its exact, complete form: a PR ref without its head sha is partial and never merges. */
export function isMergeKey(key: string): boolean {
  return PR_KEY.test(key) || ID_KEY.test(key);
}

interface Group {
  items: OwnerItem[];
  keys: Set<string>;
  /** PR ref to head sha: two heads of one PR never share an answer, whatever other key they share. */
  heads: Map<string, string>;
}

function headsOf(keys: Iterable<string>): Map<string, string> {
  const heads = new Map<string, string>();
  for (const key of keys) {
    const match = PR_KEY.exec(key);
    if (match) heads.set(match[1]!, match[2]!);
  }
  return heads;
}

function compatible(a: Map<string, string>, b: Map<string, string>): boolean {
  for (const [pr, sha] of a) {
    const other = b.get(pr);
    if (other !== undefined && other !== sha) return false;
  }
  return true;
}

function sharesKey(group: Group, keys: string[]): boolean {
  return keys.some((key) => group.keys.has(key));
}

function absorb(into: Group, from: Group): void {
  into.items.push(...from.items);
  for (const key of from.keys) into.keys.add(key);
  for (const [pr, sha] of from.heads) into.heads.set(pr, sha);
}

function place(groups: Group[], item: OwnerItem): Group[] {
  const keys = item.keys.filter(isMergeKey);
  const merged: Group = { items: [item], keys: new Set(keys), heads: headsOf(keys) };
  const rest: Group[] = [];
  for (const group of groups) {
    if (sharesKey(group, [...merged.keys]) && compatible(group.heads, merged.heads)) absorb(merged, group);
    else rest.push(group);
  }
  return [...rest, merged];
}

function unique<T>(values: T[], id: (value: T) => string): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = id(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function earliest(values: (string | undefined)[]): string | undefined {
  const present = values.filter((value): value is string => value !== undefined);
  return present.sort((a, b) => Date.parse(a) - Date.parse(b))[0];
}

/** The first item in input order is primary: its fields lead and its sources[0] receives the answer. */
function combine(items: OwnerItem[]): OwnerItem {
  const [primary, ...others] = items as [OwnerItem, ...OwnerItem[]];
  if (others.length === 0) return primary;
  const merged: OwnerItem = {
    ...primary,
    sources: unique(items.flatMap((item) => item.sources), (s: SourceRef) => `${s.system}\u0000${s.ref}`),
    keys: unique(items.flatMap((item) => item.keys), (key) => key),
    unblocks: unique(items.flatMap((item) => item.unblocks), (key) => key),
    door: items.some((item) => item.door === "one-way") ? "one-way" : "two-way",
    openedAt: earliest(items.map((item) => item.openedAt))!,
  };
  const expiresAt = earliest(items.map((item) => item.expiresAt));
  return expiresAt === undefined ? merged : { ...merged, expiresAt };
}

/**
 * Merges items from every source that share an exact key, including the head sha of a PR key.
 * Items naming two different heads of one PR stay apart even when another key matches: one
 * answer must never approve a head nobody reviewed. Output keeps the order of each group's first item.
 */
export function mergeByKeys(items: readonly OwnerItem[]): OwnerItem[] {
  const groups = items.reduce<Group[]>(place, []);
  const position = new Map(items.map((item, index) => [item, index]));
  const ordered = groups.map((group) => [...group.items].sort((a, b) => position.get(a)! - position.get(b)!));
  return ordered.sort((a, b) => position.get(a[0]!)! - position.get(b[0]!)!).map(combine);
}
