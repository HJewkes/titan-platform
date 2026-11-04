export interface IdentityGroup<T> {
  identity?: string;
  members: T[];
}

/**
 * CC-1289: items grouped by the Anthropic login each bills, in first-seen order. An item whose
 * login cannot be read is its own group, so API-key profiles never merge with each other.
 */
export function groupByIdentity<T>(items: Iterable<T>, identify: (item: T) => string | undefined): IdentityGroup<T>[] {
  const byIdentity = new Map<string, IdentityGroup<T>>();
  const groups: IdentityGroup<T>[] = [];
  for (const item of items) {
    const identity = identify(item);
    const existing = identity === undefined ? undefined : byIdentity.get(identity);
    if (existing !== undefined) {
      existing.members.push(item);
      continue;
    }
    const group: IdentityGroup<T> = identity === undefined ? { members: [item] } : { identity, members: [item] };
    groups.push(group);
    if (identity !== undefined) byIdentity.set(identity, group);
  }
  return groups;
}
