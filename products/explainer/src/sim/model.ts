import { reviewRounds } from "./models/review-rounds.js";
import type { SimRun } from "./trace-schema.js";

/**
 * A claim-reproduction model. `simulate` is pure: its only randomness is `random`, the seed's
 * generator, and it reads no clock and does no I/O, so a frozen trace can be recomputed byte for byte.
 */
export interface SimModel<P extends Record<string, number> = Record<string, number>> {
  /** Matches `doctrine/sims/<id>.yaml`. */
  id: string;
  /** Bump on any behaviour change; it is part of the trace key. */
  version: string;
  simulate(params: P, random: () => number): SimRun;
}

/** The code registry, checked against `doctrine/sims/*.yaml` as `BEAT_SLOTS` is against `beats/*.yaml`. */
export const SIM_MODELS: Readonly<Record<string, SimModel>> = { [reviewRounds.id]: reviewRounds };
