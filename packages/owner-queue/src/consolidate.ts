import { byText, dedupeClass, dependentCounts, influenceEdges, influenceOrder, prsOf, type InfluenceEdge } from "./influence.js";
import { relationKind } from "./keys.js";
import { mergeByKeys } from "./merge.js";
import { rank } from "./rank.js";
import { recheck, type RecheckDrop, type RecheckFlag } from "./recheck.js";
import type { ItemStatus, OwnerItem } from "./schema.js";
import { stackContext, supersede, type WithdrawnItem } from "./supersede.js";

export interface ConsolidateInput {
  /** Items already answered, the feedback.json answers included. */
  answered?: readonly OwnerItem[];
  /** `<owner>/<repo>#<n>` to its live head sha. */
  heads?: Readonly<Record<string, string>>;
  /** A stacked PR to its base PR. */
  stacks?: Readonly<Record<string, string>>;
  /** active-work task id to the task ids it depends on. */
  deps?: Readonly<Record<string, readonly string[]>>;
}

/** `change-requested`, `free-text`, or `other-choice`: a pick that is not the implemented (recommended) one. */
export type ShipBlockReason = "change-requested" | "free-text" | "other-choice";

export interface ShipBlock {
  itemId: string;
  reason: ShipBlockReason;
  at: string;
}

export interface FlowGroup {
  /** `pr:<owner>/<repo>#<n>` for a PR group; a topic group takes its smallest shared key, or `item:<id>`. */
  id: string;
  kind: "pr" | "topic";
  itemIds: string[];
  /** PR groups only: the open change requests at the live head, on any tab. Empty means Ship may go. */
  shipBlockedBy?: ShipBlock[];
}

export interface HeldItem {
  itemId: string;
  /** Open items served earlier that likely change this one. */
  waitsOn: string[];
}

export interface Flow {
  groups: FlowGroup[];
  order: OwnerItem[];
  held: HeldItem[];
  withdrawn: WithdrawnItem[];
  dropped: RecheckDrop[];
  flags: RecheckFlag[];
  /** Item id to the base PRs it is shown against, for items on a stacked PR. */
  context: Record<string, string[]>;
  edges: InfluenceEdge[];
}

/** A withdrawn or dropped answer no longer stands, so its change request blocks nothing. */
const ANSWERED: ReadonlySet<ItemStatus> = new Set(["answered", "decided"]);

function byId(a: OwnerItem, b: OwnerItem): number {
  return byText(a.id, b.id) || Date.parse(a.openedAt) - Date.parse(b.openedAt);
}

/** Sorted first so the newest-item tie in `supersede` and the primary in `mergeByKeys` never follow input order. */
function liveOnly(open: OwnerItem[], answered: OwnerItem[], heads: ConsolidateInput["heads"]) {
  const live = supersede([...open, ...answered], heads).heads;
  return { open: supersede(open, live), answered: supersede(answered, live).kept };
}

function dedupe(items: readonly OwnerItem[]): OwnerItem[] {
  const classes = new Map<string, OwnerItem[]>();
  for (const item of items) classes.set(dedupeClass(item), [...(classes.get(dedupeClass(item)) ?? []), item]);
  return [...classes.values()].flatMap((members) => mergeByKeys(members));
}

/**
 * Turns the open queue into the Flow the owner reads, steps 1-7 of the consolidation pass:
 * supersede old heads, re-check against answers, dedupe within a class, attach stacked
 * context, group (fixed per PR, topic groups first), order by influence and hold dependents.
 * Pure, and the same output for any input order.
 */
export function consolidate(open: readonly OwnerItem[], input: ConsolidateInput = {}): Flow {
  const { open: superseded, answered } = liveOnly([...open].sort(byId), [...(input.answered ?? [])].sort(byId), input.heads);
  const checked = recheck(superseded.kept, input.answered ?? []);
  const items = rank(dedupe(checked.open));
  const context = contextOf(items, input.stacks ?? {});
  const edges = influenceEdges(items, { context, deps: input.deps ?? {} });
  const groups = orderGroups(groupItems(items), items, edges);
  const order = groups.flatMap((group) => group.items);
  return {
    groups: groups.map(({ id, kind, items: members }) => flowGroup(id, kind, members, answered)),
    order,
    held: heldItems(order, edges),
    withdrawn: superseded.withdrawn,
    dropped: checked.dropped,
    flags: checked.flags,
    context: Object.fromEntries(context),
    edges,
  };
}

function contextOf(items: readonly OwnerItem[], stacks: Readonly<Record<string, string>>): Map<string, string[]> {
  const stacked = stackContext(items, stacks).filter(({ context }) => context.length > 0);
  return new Map(stacked.map(({ item, context }) => [item.id, context]));
}

interface Group {
  id: string;
  kind: FlowGroup["kind"];
  items: OwnerItem[];
}

/** One PR group per PR an item alone names; an item naming no PR or several joins a topic group. */
function groupItems(items: readonly OwnerItem[]): Group[] {
  const byPr = new Map<string, OwnerItem[]>();
  const loose: OwnerItem[] = [];
  for (const item of items) {
    const prs = prsOf(item);
    if (prs.length === 1) byPr.set(prs[0]!, [...(byPr.get(prs[0]!) ?? []), item]);
    else loose.push(item);
  }
  const prGroups = [...byPr].map(([pr, members]): Group => ({ id: `pr:${pr}`, kind: "pr", items: members }));
  return [...topicGroups(loose), ...prGroups];
}

function topicKeys(item: OwnerItem): string[] {
  const related = (key: string) => key.startsWith("task:") || (relationKind(key) !== null && relationKind(key) !== "ask");
  return item.keys.filter(related);
}

/** Union-find over shared task, component, token and topic keys, among items outside every PR group. */
function topicGroups(items: readonly OwnerItem[]): Group[] {
  const parent = items.map((_, index) => index);
  const root = (index: number): number => (parent[index] === index ? index : (parent[index] = root(parent[index]!)));
  const owner = new Map<string, number>();
  items.forEach((item, index) => {
    for (const key of topicKeys(item)) {
      const seen = owner.get(key);
      if (seen === undefined) owner.set(key, index);
      else parent[root(index)] = root(seen);
    }
  });
  const members = new Map<number, OwnerItem[]>();
  items.forEach((item, index) => members.set(root(index), [...(members.get(root(index)) ?? []), item]));
  return [...members.values()].map((group): Group => ({ id: topicId(group), kind: "topic", items: group }));
}

function topicId(items: readonly OwnerItem[]): string {
  const keys = items.flatMap(topicKeys).sort(byText);
  return keys[0] ?? `item:${items.map((item) => item.id).sort(byText)[0]}`;
}

/** Topic groups first, then most transitive dependents, then the best rank; members in influence order. */
function orderGroups(groups: Group[], ranked: readonly OwnerItem[], edges: readonly InfluenceEdge[]): Group[] {
  const position = new Map(ranked.map((item, index) => [item.id, index]));
  const counts = dependentCounts([...position.keys()], edges);
  const score = (group: Group) => ({
    topic: group.kind === "topic" ? 0 : 1,
    dependents: Math.max(...group.items.map((item) => counts.get(item.id)!)),
    rank: Math.min(...group.items.map((item) => position.get(item.id)!)),
  });
  const scored = groups.map((group) => ({ group, ...score(group) }));
  scored.sort((a, b) => a.topic - b.topic || b.dependents - a.dependents || a.rank - b.rank || byText(a.group.id, b.group.id));
  return scored.map(({ group }) => {
    const members = [...group.items].sort((a, b) => position.get(a.id)! - position.get(b.id)!);
    return { ...group, items: influenceOrder(members, edges) };
  });
}

/** Only edges from earlier in the order hold, so a cycle can never hold every item in it. */
function heldItems(order: readonly OwnerItem[], edges: readonly InfluenceEdge[]): HeldItem[] {
  const position = new Map(order.map((item, index) => [item.id, index]));
  return order.flatMap((item) => {
    const before = position.get(item.id)!;
    const upstream = edges.filter(({ from, to }) => to === item.id && position.get(from)! < before).map(({ from }) => from);
    const waitsOn = [...new Set(upstream)].sort((a, b) => position.get(a)! - position.get(b)!);
    return waitsOn.length === 0 ? [] : [{ itemId: item.id, waitsOn }];
  });
}

function flowGroup(id: string, kind: FlowGroup["kind"], items: OwnerItem[], answered: readonly OwnerItem[]): FlowGroup {
  const itemIds = items.map((item) => item.id);
  return kind === "pr" ? { id, kind, itemIds, shipBlockedBy: shipBlocks(id.slice("pr:".length), answered) } : { id, kind, itemIds };
}

function asks(item: OwnerItem): string[] {
  return item.keys.filter((key) => relationKind(key) === "ask");
}

/** A newer answer to the same `ask:` replaces an older one, so a change request the owner withdrew stops blocking. */
function currentAnswers(answered: readonly OwnerItem[]): OwnerItem[] {
  const newest = [...answered].sort((a, b) => Date.parse(b.answer!.at) - Date.parse(a.answer!.at) || byText(a.id, b.id));
  const seen = new Set<string>();
  return newest.filter((item) => {
    const keys = asks(item);
    const replaced = keys.some((key) => seen.has(key));
    for (const key of keys) seen.add(key);
    return !replaced;
  });
}

function reasonsOf(item: OwnerItem): ShipBlockReason[] {
  const answer = item.answer!;
  const reasons: ShipBlockReason[] = [];
  if (answer.changeRequested === true) reasons.push("change-requested");
  if (answer.text?.trim() || (answer.variantComments?.length ?? 0) > 0) reasons.push("free-text");
  const implemented = item.recommended?.optionId;
  if (answer.optionId !== undefined && implemented !== undefined && answer.optionId !== implemented) reasons.push("other-choice");
  return reasons;
}

/**
 * Owner items 166 and 167: only an open change request blocks a ship, never an unanswered
 * question. `answered` is already at the live head, so a request against an old head is gone.
 */
function shipBlocks(pr: string, answered: readonly OwnerItem[]): ShipBlock[] {
  const onPr = answered.filter((item) => item.answer !== undefined && ANSWERED.has(item.status) && prsOf(item).includes(pr));
  return currentAnswers(onPr)
    .flatMap((item) => reasonsOf(item).map((reason) => ({ itemId: item.id, reason, at: item.answer!.at })))
    .sort((a, b) => byText(a.itemId, b.itemId) || byText(a.reason, b.reason));
}
