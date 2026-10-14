import type { Claim, Phase } from "./schema.js";

/**
 * The claim-phase transition table: every (from, to) phase edge the burndown can emit, checked when the ledger is
 * written. An edge not here is refused; there is no force path. A write that keeps a claim's phase is not an edge,
 * and reading a ledger checks nothing.
 *
 * A spawn's landing and an undone spawn both leave `spawning`; a release sends any held phase to `queued`. A queued
 * slice finishes when the PR it is linked to merges.
 */
export const PHASE_EDGES: Readonly<Record<Phase, readonly Phase[]>> = {
  queued: ["spawning", "done"],
  spawning: ["queued", "planning", "implementing", "parked", "reviewing"],
  planning: ["spawning", "queued", "done"],
  implementing: ["spawning", "queued", "parked", "shepherding", "done"],
  parked: ["spawning", "queued"],
  reviewing: ["spawning", "queued", "shepherding"],
  "awaiting-merge": ["queued", "shepherding", "done"],
  shepherding: ["queued", "done"],
  done: [],
};

/** Thrown by a ledger write that would take an edge outside `PHASE_EDGES`; the caller logs it. */
export class IllegalPhaseEdgeError extends Error {
  override name = "IllegalPhaseEdgeError";
}

export interface IllegalEdge {
  claim: string;
  from: Phase;
  to: Phase;
}

type Held = Pick<Claim, "taskId" | "slice" | "phase">;

const keyOf = (c: Held): string => `${c.taskId}#${c.slice ?? ""}`;

/** Claims of one key pair by position: a release drops the newest, a dispatch appends, and a done claim keeps its place. */
function byKey(claims: readonly Held[]): Map<string, Held[]> {
  const groups = new Map<string, Held[]>();
  for (const c of claims) groups.set(keyOf(c), [...(groups.get(keyOf(c)) ?? []), c]);
  return groups;
}

/** The phase changes from `before` to `after` that the table does not allow. */
export function illegalEdges(before: readonly Held[], after: readonly Held[]): IllegalEdge[] {
  const prior = byKey(before);
  return [...byKey(after)].flatMap(([claim, now]) =>
    now.flatMap((c, i): IllegalEdge[] => {
      const was = prior.get(claim)?.[i];
      if (was === undefined || was.phase === c.phase || PHASE_EDGES[was.phase].includes(c.phase)) return [];
      return [{ claim, from: was.phase, to: c.phase }];
    }),
  );
}

/** The error a write throws for its first illegal edge, or undefined when every edge is in the table. */
export function illegalEdgeError(before: readonly Held[], after: readonly Held[]): IllegalPhaseEdgeError | undefined {
  const [edge] = illegalEdges(before, after);
  if (edge === undefined) return undefined;
  return new IllegalPhaseEdgeError(`claim ${edge.claim} may not move from ${edge.from} to ${edge.to}`);
}
