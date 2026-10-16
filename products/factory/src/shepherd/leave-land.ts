import type { LandOutcome } from "../workflows/land.js";

/** Thrown out of `land` to end the round early: with no outcome the next round lands, with one the run ends. */
export class LeaveLand extends Error {
  constructor(readonly outcome?: LandOutcome) {
    super(outcome ? `left land: ${outcome.kind}` : "left land for the next round");
  }
}

/** Runs `body`, reading a `LeaveLand` it throws as that leave's outcome. */
export async function untilLeft(body: () => Promise<LandOutcome | undefined>): Promise<LandOutcome | undefined> {
  try {
    return await body();
  } catch (error) {
    if (error instanceof LeaveLand) return error.outcome;
    throw error;
  }
}
