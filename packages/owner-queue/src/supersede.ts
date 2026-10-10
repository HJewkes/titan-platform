import type { ItemStatus, OwnerItem } from "./schema.js";

const FULL_SHA = /^[0-9a-f]{40}$/;
const PINNED_PR_KEY = /^pr:([\w.-]+\/[\w.-]+#\d+)@([0-9a-f]{40})$/;

/** Statuses whose item or answer would still count at the PR's live head. */
const SUPERSEDABLE: ReadonlySet<ItemStatus> = new Set(["open", "answered", "decided"]);

export interface WithdrawnItem {
  /** The item relabelled `withdrawn`; an answer it carried is kept, so a change request stays readable. */
  item: OwnerItem;
  /** The status it had before it was withdrawn. */
  was: ItemStatus;
  /** `<owner>/<repo>#<n>`, lower-cased. */
  pr: string;
  /** `new-head:<live sha>`. */
  reason: string;
}

export interface Superseded {
  /** Every item not withdrawn, in input order. */
  kept: OwnerItem[];
  withdrawn: WithdrawnItem[];
  /** The live head of each PR any item pins: `heads[pr]` when it is a full sha, else the newest item's. */
  heads: Record<string, string>;
}

interface PinnedPr {
  pr: string;
  sha: string;
}

function pinnedPrs(item: OwnerItem): PinnedPr[] {
  return item.keys.flatMap((key) => {
    const match = PINNED_PR_KEY.exec(key.trim().toLowerCase());
    return match ? [{ pr: match[1]!, sha: match[2]! }] : [];
  });
}

function prRefs(item: OwnerItem): string[] {
  return item.keys.flatMap((key) => {
    const normal = key.trim().toLowerCase();
    if (!normal.startsWith("pr:")) return [];
    const at = normal.lastIndexOf("@");
    return [at < 0 ? normal.slice(3) : normal.slice(3, at)];
  });
}

function givenHeads(heads: Readonly<Record<string, string>> | undefined): Map<string, string> {
  const entries = Object.entries(heads ?? {}).map(([pr, sha]) => [pr.trim().toLowerCase(), sha.trim().toLowerCase()] as const);
  return new Map(entries.filter(([, sha]) => FULL_SHA.test(sha)));
}

/** The newest item wins; on equal `openedAt` the later one in input order does. */
function newestHeads(items: readonly OwnerItem[]): Map<string, string> {
  const newest = new Map<string, { sha: string; at: number }>();
  for (const item of items) {
    const at = Date.parse(item.openedAt);
    for (const { pr, sha } of pinnedPrs(item)) {
      const seen = newest.get(pr);
      if (seen === undefined || at >= seen.at) newest.set(pr, { sha, at });
    }
  }
  return new Map([...newest].map(([pr, { sha }]) => [pr, sha]));
}

function liveHeads(items: readonly OwnerItem[], heads: Readonly<Record<string, string>> | undefined): Map<string, string> {
  const live = newestHeads(items);
  for (const [pr, sha] of givenHeads(heads)) live.set(pr, sha);
  return live;
}

function staleHead(item: OwnerItem, live: Map<string, string>): PinnedPr | undefined {
  if (!SUPERSEDABLE.has(item.status)) return undefined;
  return pinnedPrs(item).find(({ pr, sha }) => live.has(pr) && live.get(pr) !== sha);
}

function withdraw(item: OwnerItem, pr: string, liveSha: string): WithdrawnItem {
  return { item: { ...item, status: "withdrawn" }, was: item.status, pr, reason: `new-head:${liveSha}` };
}

/**
 * Rule 1 of the consolidation pass. A PR's live head is `heads[pr]` (keyed `<owner>/<repo>#<n>`,
 * case-insensitively, full sha only), or else the head of its newest pinned item. An open,
 * answered or decided item pinned to any other head is withdrawn as `new-head:<sha>`: approval
 * resets on a new push, so its answer never counts at the live head. An unpinned or short-sha
 * PR key pins nothing and is never withdrawn. Pure: no clock and no I/O.
 */
export function supersede(items: readonly OwnerItem[], heads?: Readonly<Record<string, string>>): Superseded {
  const live = liveHeads(items, heads);
  const kept: OwnerItem[] = [];
  const withdrawn: WithdrawnItem[] = [];
  for (const item of items) {
    const stale = staleHead(item, live);
    if (stale === undefined) kept.push(item);
    else withdrawn.push(withdraw(item, stale.pr, live.get(stale.pr)!));
  }
  return { kept, withdrawn, heads: Object.fromEntries(live) };
}

export interface StackedItem {
  item: OwnerItem;
  /** The base PRs of the item's stacked PRs, nearest first: shown as context, not under review. */
  context: string[];
}

function normalStacks(stacks: Readonly<Record<string, string>>): Map<string, string> {
  return new Map(Object.entries(stacks).map(([pr, base]) => [pr.trim().toLowerCase(), base.trim().toLowerCase()]));
}

/** Follows base links until a PR with no base; a cycle stops at the first PR seen twice. */
function baseChain(pr: string, stacks: Map<string, string>): string[] {
  const chain: string[] = [];
  for (let base = stacks.get(pr); base !== undefined && base !== pr && !chain.includes(base); base = stacks.get(base)) {
    chain.push(base);
  }
  return chain;
}

function contextOf(item: OwnerItem, stacks: Map<string, string>): string[] {
  const own = new Set(prRefs(item));
  const bases = [...own].flatMap((pr) => baseChain(pr, stacks)).filter((base) => !own.has(base));
  return [...new Set(bases)];
}

function basesWaitedOn(stacked: StackedItem[]): number[][] {
  const prsOf = stacked.map(({ item }) => new Set(prRefs(item)));
  return stacked.map(({ context }) =>
    stacked.flatMap((_, other) => (context.some((base) => prsOf[other]!.has(base)) ? [other] : [])),
  );
}

/** Stable topological order: the first pending item whose base items are all placed goes next. */
function orderAfterBases(stacked: StackedItem[]): StackedItem[] {
  const waitsOn = basesWaitedOn(stacked);
  const placed = new Set<number>();
  const order: StackedItem[] = [];
  while (order.length < stacked.length) {
    const pending = stacked.flatMap((_, index) => (placed.has(index) ? [] : [index]));
    const ready = pending.find((index) => waitsOn[index]!.every((other) => placed.has(other)));
    const next = ready ?? pending[0]!;
    placed.add(next);
    order.push(stacked[next]!);
  }
  return order;
}

/**
 * Rule 3 of the consolidation pass. `stacks` maps a stacked PR to its base PR, both
 * `<owner>/<repo>#<n>`, case-insensitively. Each item on a stacked PR gets its base chain as
 * `context` and orders after every item on those bases; other items keep their input order.
 * A cycle in `stacks` falls back to input order for the items it joins. Pure: no clock and no I/O.
 */
export function stackContext(items: readonly OwnerItem[], stacks: Readonly<Record<string, string>>): StackedItem[] {
  const links = normalStacks(stacks);
  return orderAfterBases(items.map((item) => ({ item, context: contextOf(item, links) })));
}
