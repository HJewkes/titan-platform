import type { LandOutcome } from "../workflows/land.js";

/** Thrown out of `land` to end the round early: with no outcome the next round lands, with one the run ends. */
export class LeaveLand extends Error {
  constructor(readonly outcome?: LandOutcome) {
    super(outcome ? `left land: ${outcome.kind}` : "left land for the next round");
  }
}
