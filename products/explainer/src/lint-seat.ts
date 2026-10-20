import type { PaceBeat } from "./pace-items.js";

/** M5a: the most invariants one beat may state, and only with a map on screen. */
const MAX_INVARIANTS_PER_BEAT = 1;

const normalize = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

// Padding both sides with a space keeps word boundaries: "restarts" does not match inside "restartsafe".
export const speaks = (spoken: string, phrase: string): boolean => ` ${normalize(spoken)} `.includes(` ${normalize(phrase)} `);

/**
 * Invariants a beat states: the larger of its `inv:` items and the `invariants` phrases its spoken text says.
 * Max, not sum: an `inv:` label ("I7 survives restart") and its spoken phrase ("State survives restarts.") are one
 * invariant told twice, and labels differ from phrases, so a sum would count it twice.
 */
export function invariantsStated(beat: PaceBeat, invariants: readonly string[]): number {
  const cued = beat.items.filter((i) => i.kind === "inv").length;
  const spoken = invariants.filter((inv) => normalize(inv) !== "" && speaks(beat.spoken, inv)).length;
  return Math.max(cued, spoken);
}

/**
 * M5a: beats that state an invariant with no map beside them, or state more than one. Neither ScriptV1 nor the v4
 * spike has a `seat:` field, so script-method's `seat: {mechanism, failure}` alternative waits for the spine (TP-2988).
 */
export function unseated(beats: readonly PaceBeat[], invariants: readonly string[]): string[] {
  return beats
    .filter((beat) => {
      const stated = invariantsStated(beat, invariants);
      return stated >= 1 && (!beat.mapBeside || stated > MAX_INVARIANTS_PER_BEAT);
    })
    .map((b) => b.id);
}

const isFinding = (beat: PaceBeat): boolean => beat.render === "StatBeat" && beat.items.some((i) => i.kind === "stat");

/**
 * M5b: StatBeat findings with no map on their own beat or the one before or after it in script order. Chapter
 * bounds are ignored; on v4 either reading routes the same beats. A route for the L1 seat judge, never an error.
 */
export function findingRoutes(beats: readonly PaceBeat[]): string[] {
  return beats
    .filter((beat, i) => isFinding(beat) && ![beats[i - 1], beat, beats[i + 1]].some((b) => b?.mapBeside))
    .map((b) => b.id);
}

/** Why a beat goes to the L1 seat judge. */
export type SeatReason = "invariant" | "finding";

/** One beat the L1 seat judge (TP-2982) asks "is this seated in the architecture?" about. */
export interface SeatRoute {
  beat: string;
  reason: SeatReason;
}

/** The M5a and M5b beats in script order, each with the reason it is asked about. */
export function seatRoutes(beats: readonly PaceBeat[], invariants: readonly string[]): SeatRoute[] {
  const reasons = new Map<string, SeatReason>([
    ...findingRoutes(beats).map((id): [string, SeatReason] => [id, "finding"]),
    ...unseated(beats, invariants).map((id): [string, SeatReason] => [id, "invariant"]),
  ]);
  return beats.flatMap((b) => {
    const reason = reasons.get(b.id);
    return reason ? [{ beat: b.id, reason }] : [];
  });
}
