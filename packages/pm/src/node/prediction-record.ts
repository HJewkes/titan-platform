import { checkPrediction } from "../prediction-check.js";
import type { ScorecardWeekRow } from "../prediction-check.js";
import type { Bet } from "../planning.js";
import { withPlanLock } from "./plan-lock.js";
import { loadPlanRecords, writePlanRecord } from "./plan-store.js";

/** Reads every bet of the initiative against the rows and stores the result on the bet; returns the bets as written. */
export async function recordPredictionChecks(activeRoot: string, initiative: string, rows: readonly ScorecardWeekRow[]): Promise<Bet[]> {
  return withPlanLock(activeRoot, initiative, async () => {
    const bets = await loadPlanRecords(activeRoot, initiative, "bet");
    return Promise.all(bets.map((bet) => writePlanRecord(activeRoot, "bet", { ...bet, prediction_check: checkPrediction(bet, rows) })));
  });
}
