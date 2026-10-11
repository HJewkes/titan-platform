import { relationKind } from "./keys.js";
import { isMergeKey } from "./merge.js";
import type { OwnerItem } from "./schema.js";

/**
 * Why A likely changes B: `base` (A is on B's base PR), `pr-decision` (A decides on B's PR),
 * `shared-unit` (A decides or is one-way on B's component or token), `unblocks` (A unblocks B's
 * task, or B's task depends on A's), `topic` (A decides B's topic) and `overlap` (A and B share a
 * merge key but were kept apart by dedupe).
 */
export const INFLUENCE_RULES = ["base", "pr-decision", "shared-unit", "unblocks", "topic", "overlap"] as const;
export type InfluenceRule = (typeof INFLUENCE_RULES)[number];

/** A likely changes B, so B is served after A is answered. */
export interface InfluenceEdge {
  from: string;
  to: string;
  rules: InfluenceRule[];
}

export interface InfluenceContext {
  /** Item id to the base PRs it is shown against, as `stackContext` returns them. */
  context: ReadonlyMap<string, readonly string[]>;
  /** active-work task id to the task ids it depends on. */
  deps: Readonly<Record<string, readonly string[]>>;
}

interface Facts {
  item: OwnerItem;
  prs: Set<string>;
  bases: Set<string>;
  tasks: Set<string>;
  units: Set<string>;
  topics: Set<string>;
  mergeKeys: Set<string>;
}

const KIND_STAGE: Readonly<Record<OwnerItem["kind"], number>> = { decide: 0, review: 1, approve: 2, do: 3, know: 4 };

/** The `<owner>/<repo>#<n>` refs an item names, lower-cased, with any head dropped. */
export function prsOf(item: OwnerItem): string[] {
  const refs = item.keys.flatMap((key) => {
    const normal = key.trim().toLowerCase();
    if (!normal.startsWith("pr:")) return [];
    const at = normal.lastIndexOf("@");
    return [at < 0 ? normal.slice(3) : normal.slice(3, at)];
  });
  return [...new Set(refs)];
}

function isRound(item: OwnerItem): boolean {
  return item.sources[0]?.system === "round";
}

/**
 * Dedupe merges only within one class: the item kind, with round questions apart from every
 * other source, so answering a review round never resolves a gate (g10).
 */
export function dedupeClass(item: OwnerItem): string {
  return `${item.kind}/${isRound(item) ? "round" : "queue"}`;
}

/** Decisions come before reviews before approvals; a round comes before the gate on the same kind. */
function stage(item: OwnerItem): number {
  return KIND_STAGE[item.kind] * 2 + (isRound(item) ? 0 : 1);
}

function factsOf(item: OwnerItem, context: InfluenceContext["context"]): Facts {
  const keyed = (kinds: string[]) => new Set(item.keys.filter((key) => kinds.includes(relationKind(key) ?? "")));
  return {
    item,
    prs: new Set(prsOf(item)),
    bases: new Set(context.get(item.id) ?? []),
    tasks: new Set(item.keys.filter((key) => key.startsWith("task:"))),
    units: keyed(["component", "token"]),
    topics: keyed(["topic"]),
    mergeKeys: new Set(item.keys.filter(isMergeKey).map((key) => (/^pr:/i.test(key) ? key.toLowerCase() : key))),
  };
}

function shares(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return [...a].some((value) => b.has(value));
}

function reviews(item: OwnerItem): boolean {
  return item.kind === "review" || item.kind === "approve";
}

function dependsOn(a: Facts, b: Facts, deps: InfluenceContext["deps"]): boolean {
  if (a.item.unblocks.some((key) => b.tasks.has(key))) return true;
  const upstream = new Set([...b.tasks].flatMap((task) => deps[task.slice("task:".length)] ?? []).map((id) => `task:${id}`));
  return shares(a.tasks, upstream);
}

function rulesFor(a: Facts, b: Facts, deps: InfluenceContext["deps"]): InfluenceRule[] {
  const decides = a.item.kind === "decide";
  const checks: Record<InfluenceRule, boolean> = {
    base: shares(a.prs, b.bases),
    "pr-decision": decides && reviews(b.item) && shares(a.prs, b.prs),
    "shared-unit": (decides || a.item.door === "one-way") && reviews(b.item) && shares(a.units, b.units),
    unblocks: dependsOn(a, b, deps),
    topic: decides && b.item.kind !== "decide" && shares(a.topics, b.topics),
    overlap: dedupeClass(a.item) !== dedupeClass(b.item) && stage(a.item) < stage(b.item) && shares(a.mergeKeys, b.mergeKeys),
  };
  return INFLUENCE_RULES.filter((rule) => checks[rule]);
}

/** Every influence edge between distinct items, ordered by `from` then `to` id. */
export function influenceEdges(items: readonly OwnerItem[], { context, deps }: InfluenceContext): InfluenceEdge[] {
  const facts = [...items].sort((a, b) => byText(a.id, b.id)).map((item) => factsOf(item, context));
  return facts.flatMap((a) =>
    facts.flatMap((b) => {
      if (a.item.id === b.item.id) return [];
      const rules = rulesFor(a, b, deps);
      return rules.length === 0 ? [] : [{ from: a.item.id, to: b.item.id, rules }];
    }),
  );
}

/** Code-unit order, so the output never depends on the runtime's locale. */
export function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function successors(edges: readonly InfluenceEdge[]): Map<string, string[]> {
  const next = new Map<string, string[]>();
  for (const { from, to } of edges) next.set(from, [...(next.get(from) ?? []), to]);
  return next;
}

/** Item id to how many items it reaches through influence edges, itself excluded even in a cycle. */
export function dependentCounts(ids: readonly string[], edges: readonly InfluenceEdge[]): Map<string, number> {
  const next = successors(edges);
  return new Map(
    ids.map((id) => {
      const seen = new Set<string>();
      const stack = [...(next.get(id) ?? [])];
      for (let at = stack.pop(); at !== undefined; at = stack.pop()) {
        if (seen.has(at)) continue;
        seen.add(at);
        stack.push(...(next.get(at) ?? []));
      }
      seen.delete(id);
      return [id, seen.size];
    }),
  );
}

/**
 * Topological order of `ranked` (already in rank order) over the edges between them: the
 * best-ranked item whose upstream items are all placed goes next. In a cycle no item is ready,
 * so the best-ranked pending item goes next and breaks it.
 */
export function influenceOrder(ranked: readonly OwnerItem[], edges: readonly InfluenceEdge[]): OwnerItem[] {
  const ids = new Set(ranked.map((item) => item.id));
  const inner = edges.filter(({ from, to }) => ids.has(from) && ids.has(to));
  const placed = new Set<string>();
  const order: OwnerItem[] = [];
  while (order.length < ranked.length) {
    const pending = ranked.filter((item) => !placed.has(item.id));
    const ready = pending.find((item) => inner.every(({ from, to }) => to !== item.id || placed.has(from)));
    const next = ready ?? pending[0]!;
    placed.add(next.id);
    order.push(next);
  }
  return order;
}
