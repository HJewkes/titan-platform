import type { OwnerOp } from "@titan-design/owner-queue";
import type { Bet, Freeze, Outcome } from "@titan-design/pm";
import { readPlanRecord } from "@titan-design/pm/node";

/** One bet an op names, as the plan store holds it now, with the outcome it serves; null where no such record exists. */
interface BetFacts {
  id: string;
  bet: Bet | null;
  outcome: Outcome | null;
}

/** What a planning op's read-back shows, read from the plan store at preview time, never from the deposit. */
export interface PlanPreview {
  bets?: BetFacts[];
  outcome?: Outcome | null;
  freeze?: Freeze | null;
}

async function betFacts(activeRoot: string, id: string): Promise<BetFacts> {
  const bet = await readPlanRecord(activeRoot, "bet", id);
  return { id, bet, outcome: bet === null ? null : await readPlanRecord(activeRoot, "outcome", bet.outcome) };
}

/** Read without the plan lock, as the other previews read: the apply re-reads every record under it. */
export async function planPreview(op: OwnerOp, activeRoot: string): Promise<PlanPreview | undefined> {
  if (op.kind === "plan-bet-select") return { bets: await Promise.all(op.bets.map((id) => betFacts(activeRoot, id))) };
  if (op.kind === "plan-outcome-edit") return { outcome: await readPlanRecord(activeRoot, "outcome", op.outcome) };
  if (op.kind !== "plan-freeze-set") return undefined;
  return op.freeze.action === "end" ? { freeze: await readPlanRecord(activeRoot, "freeze", op.freeze.id) } : {};
}
