import type { LandOutcome } from "../workflows/land.js";
import { GATE_DEMOTIONS, type GateDemotions } from "./auto-pass.js";
import { noticeHeldSeat } from "./gate-route.js";
import { awaitNewHead, conflictGate, type GateRun } from "./gates.js";

/** Fixer attempts at one conflict under D9: the implementer's, then one fresh agent's. */
const MAX_CONFLICT_WAKES = 2;

interface ConflictRun extends GateRun {
  /** Conflict wakes since the PR was last green. */
  conflictWakes: number;
}

/** Wakes a fixer with `payload`; true when an agent took it and a new head is up. */
type Wake = (payload: unknown) => Promise<boolean>;

/** One fixer attempt per conflict, the implementer's; a conflict that survives it goes to `demoteConflict`. Undefined lands the next round. */
export async function fixConflict(run: ConflictRun, headSha: string, wake: Wake): Promise<LandOutcome | undefined> {
  if (run.conflictWakes >= 1) return demoteConflict(run, headSha, wake);
  run.conflictWakes += 1;
  if (await wake({ mergeableState: "dirty" })) return undefined;
  return { kind: "stopped", reason: "not-mergeable", headSha, detail: "mergeable_state is dirty and no agent took the conflict wake" };
}

/**
 * D9 (TP-3734): the owner approved every conflict gate, which only waited for a resolved head, so a conflict that
 * survives one fixer wakes one fresh fixer and then tells the seat, and the run waits for a new head. Only a notice that
 * could not go out asks the owner. Undefined lands the next round.
 */
async function demoteConflict(run: ConflictRun, headSha: string, wake: Wake, demotions: GateDemotions = GATE_DEMOTIONS): Promise<LandOutcome | undefined> {
  if (!demotions.conflict) return conflictGate(run, headSha);
  let last = "the fresh fixer's head still conflicts with its base";
  if (run.conflictWakes < MAX_CONFLICT_WAKES) {
    run.conflictWakes += 1;
    if (await wake({ mergeableState: "dirty", freshFixer: true })) return undefined;
    last = "no fresh fixer took the second wake";
  }
  const why = `a merge conflict survived the implementer's attempt and ${last}`;
  const told = await noticeHeldSeat(run, JSON.stringify(["conflict", headSha]), { headSha, why, gate: "conflict" });
  return told?.sent === false ? conflictGate(run, headSha, ` (${told.detail})`) : awaitNewHead(run, headSha);
}
