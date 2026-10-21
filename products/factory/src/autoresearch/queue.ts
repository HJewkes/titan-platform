import { preCheck, type Bounds } from "./bounds.js";
import { inDeadEnd, type DeadEnd } from "./registry.js";
import { ideaId, type Idea, type Proposal, type QueueOps } from "./schemas.js";

interface QueueContext {
  round: number;
  bounds: Bounds;
  seedNames: readonly string[];
  deadEnds: readonly DeadEnd[];
  /** Every idea id already queued or evaluated, so an exact repeat is refused. */
  seen: ReadonlySet<string>;
  /** Lineage of every idea id seen, so a follow-up or requeue inherits its parent's. */
  lineageOf: ReadonlyMap<string, string>;
}

interface QuotaContext {
  /** Ideas kept last round; each one owes a follow-up. */
  keptLastRound: readonly string[];
  minPool: number;
  queuedBefore: number;
}

interface Applied {
  queue: Idea[];
  rejected: { proposal: Proposal; code: string }[];
}

export function toIdea(proposal: Proposal, context: Pick<QueueContext, "round" | "lineageOf">): Idea {
  const id = ideaId(proposal);
  const lineage = (proposal.parent && context.lineageOf.get(proposal.parent)) || id;
  return { ...proposal, id, lineage, cell: `${proposal.class}:${proposal.direction}`, round: context.round };
}

/** Quotas the planner must meet each round (plan 4.2); an empty list means the ops may be applied. */
export function quotaViolations(ops: QueueOps, quota: QuotaContext): string[] {
  const violations: string[] = [];
  if (!ops.add.some((proposal) => proposal.bold) && !ops.exempt.bold) violations.push("no bold idea and no [EXEMPT] reason");
  for (const kept of quota.keptLastRound) {
    const followed = ops.add.some((proposal) => proposal.source === "followup" && proposal.parent === kept);
    if (!followed && !ops.exempt.followup) violations.push(`no follow-up for kept idea ${kept}`);
  }
  const pool = quota.queuedBefore + ops.add.length - ops.drop.length;
  if (pool < quota.minPool) violations.push(`candidate pool ${pool} is under ${quota.minPool}`);
  return violations;
}

function admit(proposal: Proposal, context: QueueContext, queued: ReadonlySet<string>): Idea | string {
  const idea = toIdea(proposal, context);
  if (queued.has(idea.id) || context.seen.has(idea.id)) return "duplicate";
  const bound = preCheck(proposal, context.bounds, context.seedNames);
  if (bound) return bound;
  if (inDeadEnd(idea, context.deadEnds) && !proposal.differsFrom) return "dead-end";
  return idea;
}

/** Drops and reprioritizes touch queued ideas only; an owner idea is dropped only with a reason. */
function dropAndReprioritize(queue: readonly Idea[], ops: QueueOps): Idea[] {
  const dropped = new Set(ops.drop.filter((drop) => drop.reason || queue.find((idea) => idea.id === drop.id)?.source !== "owner").map((drop) => drop.id));
  const priorities = new Map(ops.reprioritize.map((entry) => [entry.id, entry.priority]));
  return queue.filter((idea) => !dropped.has(idea.id)).map((idea) => (priorities.has(idea.id) ? { ...idea, priority: priorities.get(idea.id)! } : idea));
}

/** Applies the planner's ops mechanically: adds pass dedup, the bounds pre-check and the dead-end rule, at no model cost. */
export function applyOps(queue: readonly Idea[], ops: QueueOps, context: QueueContext): Applied {
  const next = dropAndReprioritize(queue, ops);
  const queued = new Set(next.map((idea) => idea.id));
  const rejected: Applied["rejected"] = [];
  for (const proposal of ops.add) {
    const admitted = admit(proposal, context, queued);
    if (typeof admitted === "string") {
      rejected.push({ proposal, code: `rejected:pre:${admitted}` });
      continue;
    }
    next.push(admitted);
    queued.add(admitted.id);
  }
  return { queue: next, rejected };
}
