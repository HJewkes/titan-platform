import type { ActivityCategory, BrokerEvent, NodeActivity } from "./types.js";

/**
 * The broker's spawn tree, read off its event log. An `agent_spawned` row puts
 * the spawner in `from` and the spawned name in `meta.target`, which is real
 * parentage rather than a guess about who coordinates. Pure: no clock, no DOM.
 * Ported from agent-chat `src/dashboard/agent-graph.ts`.
 */

export const HUMAN = "human";

/** A `route_failed` target is what the sender typed (`*`, `?`, `a, b`), so only a resolved name is a peer. */
export const isPeerName = (name: string): boolean => name !== "" && !/[\s,*?]/.test(name);

const CATEGORY_BY_KIND: Partial<Record<string, ActivityCategory>> = {
  message: "message",
  broadcast: "message",
  question: "question",
  approval_request: "question",
  notice: "notice",
  answer: "notice",
  resolution: "notice",
};

/** `thinking` is the residual: a newest row that is lifecycle rather than talk. */
export function activityCategory(kind: string): ActivityCategory {
  return CATEGORY_BY_KIND[kind] ?? "thinking";
}

/** Newest activity per name, sender and recipient alike: being asked is as active as asking. */
export function nodeActivity(items: readonly BrokerEvent[]): Map<string, NodeActivity> {
  const latest = new Map<string, NodeActivity>();
  const touch = (name: string, activity: NodeActivity) => {
    if (!isPeerName(name)) return;
    const current = latest.get(name);
    if (!current || activity.at >= current.at) latest.set(name, activity);
  };

  for (const item of items) {
    if (item.kind === "route_failed") continue;
    const activity: NodeActivity = { category: activityCategory(item.kind), at: item.at };
    touch(item.from, activity);
    touch(item.meta["target"] ?? "", activity);
  }
  return latest;
}

/** Every name the log knows, each pointing at its spawner (null for a root). */
export function buildSpawnTree(items: readonly BrokerEvent[]): Map<string, string | null> {
  const parents = new Map<string, string | null>();
  const see = (name: string) => {
    if (isPeerName(name) && !parents.has(name)) parents.set(name, null);
  };

  for (const item of items) {
    if (item.kind === "route_failed") continue;
    see(item.from);
    see(item.meta["target"] ?? "");
    for (const name of (item.meta["audience"] ?? "").split(",")) see(name.trim());
    const child = spawnedChild(item);
    // Last spawn wins: a retired name can be spawned again by someone else.
    if (child !== null) parents.set(child, item.from);
  }

  for (const [name, parent] of parents) {
    if (parent !== null && wouldCycle(parents, name)) parents.set(name, null);
  }
  return parents;
}

function spawnedChild(item: BrokerEvent): string | null {
  if (item.kind !== "agent_spawned") return null;
  const child = item.meta["target"] ?? item.meta["name"] ?? "";
  if (!isPeerName(child) || child === item.from || !isPeerName(item.from)) return null;
  return child;
}

/** A malformed log must not hang the walk; a name that reaches itself is a root. */
function wouldCycle(parents: Map<string, string | null>, start: string): boolean {
  const seen = new Set<string>([start]);
  let cursor = parents.get(start) ?? null;
  while (cursor !== null) {
    if (seen.has(cursor)) return true;
    seen.add(cursor);
    cursor = parents.get(cursor) ?? null;
  }
  return false;
}
