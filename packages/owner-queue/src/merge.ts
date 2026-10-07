import type { OwnerItem, SourceRef } from "./schema.js";

const PR_KEY = /^pr:[\w.-]+\/[\w.-]+#\d+@[0-9a-f]{40}$/;
const FULL_SHA = /^[0-9a-f]{40}$/;
const ID_KEY = /^(task|gate|run):\S+$/;

/** GitHub owner, repo and sha compare case-insensitively; task, gate and run ids are exact. */
function canonical(key: string): string {
  return /^pr:/i.test(key) ? key.toLowerCase() : key;
}

/** A key merges only in its exact, complete form: a PR ref needs its full 40-hex head sha. */
export function isMergeKey(key: string): boolean {
  const normal = canonical(key);
  return PR_KEY.test(normal) || ID_KEY.test(normal);
}

interface Group {
  items: OwnerItem[];
  keys: Set<string>;
  /** PR ref to its full head sha, or null when unpinned, short or ambiguous: such a PR shares no answer. */
  heads: Map<string, string | null>;
}

function headsOf(keys: readonly string[]): Map<string, string | null> {
  const heads = new Map<string, string | null>();
  for (const key of keys.map(canonical).filter((each) => each.startsWith("pr:"))) {
    const at = key.lastIndexOf("@");
    const pr = at < 0 ? key : key.slice(0, at);
    const sha = at >= 0 && FULL_SHA.test(key.slice(at + 1)) ? key.slice(at + 1) : null;
    heads.set(pr, heads.has(pr) && heads.get(pr) !== sha ? null : sha);
  }
  return heads;
}

/** Any PR both sides name must carry the same full head sha on both. */
function compatible(a: Map<string, string | null>, b: Map<string, string | null>): boolean {
  for (const [pr, sha] of a) {
    if (!b.has(pr)) continue;
    if (sha === null || b.get(pr) !== sha) return false;
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
  const keys = item.keys.filter(isMergeKey).map(canonical);
  const merged: Group = { items: [item], keys: new Set(keys), heads: headsOf(item.keys) };
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
