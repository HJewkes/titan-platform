import type { Phase } from "./step-phase.js";

const MINUTE = 60_000;

export const MERGING_STALL_LIMIT_MS = 15 * MINUTE;

/** Longest a run may sit in a phase before it reads as stalled; phases that wait on a person or an agent by design have no limit. */
export const PHASE_STALL_LIMIT_MS: Readonly<Partial<Record<Phase, number>>> = {
  ci: 60 * MINUTE,
  fixing: 240 * MINUTE,
  review: 120 * MINUTE,
  merging: MERGING_STALL_LIMIT_MS,
};
