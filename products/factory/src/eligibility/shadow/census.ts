/*
 * The work-supply census's "dispatchable" rule (2026-11 supply study), so the ready-stock floor counts what the census
 * counts: an open task tagged brief:ready that no blocking class claims. Tags match by lowercase prefix, as the census does.
 */

interface CensusTask {
  tags?: readonly string[] | undefined;
  notes?: string | undefined;
}

interface BlockingClass {
  tagPrefixes: readonly string[];
  note?: RegExp;
}

const BLOCKING_CLASSES: readonly BlockingClass[] = [
  {
    tagPrefixes: ["human-only", "kind:operator", "owner-ask", "owner-validate", "needs-owner", "human-action", "human-queue", "owner-gate"],
    note: /needs (the )?owner|owner[- ]gated|owner-only|waits? (on|for) (the )?owner/i,
  },
  { tagPrefixes: ["needs-decision"] },
  { tagPrefixes: ["parked", "held", "hold", "on-hold", "deferred", "backlog", "icebox"], note: /\b(parked|on hold|held until|do not start)\b/i },
  { tagPrefixes: ["blocked"], note: /^\s*blocked/i },
  { tagPrefixes: ["needs-plan", "plan-first", "kind:plan"], note: /plan-first/i },
  { tagPrefixes: ["superseded", "duplicate", "dup", "obsolete"], note: /\b(superseded by|duplicate of|dupe of|obsoleted by)\b/i },
];

const hasTag = (tags: readonly string[], prefixes: readonly string[]): boolean => tags.some((tag) => prefixes.some((prefix) => tag.startsWith(prefix)));

/** Whether one open task counts toward its lane's ready stock. */
export function censusDispatchable(task: CensusTask): boolean {
  const tags = (task.tags ?? []).map((tag) => tag.toLowerCase());
  const notes = task.notes ?? "";
  if (!hasTag(tags, ["brief:ready"])) return false;
  return !BLOCKING_CLASSES.some((blocking) => hasTag(tags, blocking.tagPrefixes) || blocking.note?.test(notes) === true);
}
