/**
 * A planning op's read-back (TP-5453 P3b): the owner selects bets, edits an outcome, or sets or ends a freeze from the phone.
 * Every fact shown comes from the factory's `owner-op.preview`, which reads active-work's plan store now; the deposit names
 * only the target and the owner's new words. An outcome edit posts the before the owner was shown, so the factory refuses
 * the tap when the outcome changed under it.
 */
import type { OwnerItem, OwnerOp } from "@titan-design/owner-queue";
import type { Bet, Freeze, FreezeEndCondition, Outcome, Prediction } from "@titan-design/pm";

type PlanOp = Extract<OwnerOp, { kind: "plan-bet-select" | "plan-outcome-edit" | "plan-freeze-set" }>;

/** The factory's plan preview as the console pins it; `shepherd.ts` parses it with pm's own schemas. */
interface PlanFacts {
  bets?: { id: string; bet: Bet | null; outcome: Outcome | null }[];
  outcome?: Outcome | null;
  freeze?: Freeze | null;
}

interface Proposed {
  authority: string;
  proposedBy: string;
  proposal: string;
  effect: string;
}

/** One bet as the owner decides on it: the outcome it serves, its prediction, and the tasks it covers. */
interface BetLine {
  id: string;
  order: number;
  outcome: string;
  outcomeStatement: string | null;
  prediction: Prediction;
  tasks: string[];
  selector: string | null;
  state: Bet["state"];
}

interface OutcomeText {
  statement: string;
  measure: string;
}

export type PlanReadBack =
  | (Proposed & { planOp: "bet-select"; initiative: string; week: string; bets: BetLine[] })
  | (Proposed & { planOp: "outcome-edit"; outcomeId: string; before: OutcomeText; after: OutcomeText })
  | (Proposed & { planOp: "freeze"; action: "set" | "end"; initiative: string; freezeId: string | null; stops: string; reason: string; ends: string });

type Base = Omit<Proposed, "effect">;

export const isPlanOp = (op: OwnerOp): op is PlanOp => op.kind === "plan-bet-select" || op.kind === "plan-outcome-edit" || op.kind === "plan-freeze-set";

const proposedOf = (item: OwnerItem, authority: string): Base => ({ authority, proposedBy: item.asker ?? "an agent", proposal: item.summary });

/** The read-back, or the reason the console offers no tap: a record is missing, of another week, or already as asked. */
export function planReadBackOf(item: OwnerItem, op: PlanOp, facts: PlanFacts | undefined, authority: string): PlanReadBack | string {
  if (facts === undefined) return `the factory read no plan records back for this ${op.kind} op`;
  const base = proposedOf(item, authority);
  if (op.kind === "plan-bet-select") return betSelectReadBack(op, facts.bets ?? [], base);
  if (op.kind === "plan-outcome-edit") return outcomeEditReadBack(op, facts.outcome ?? null, base);
  return freezeReadBack(op, facts.freeze ?? null, base);
}

type BetSelect = Extract<PlanOp, { kind: "plan-bet-select" }>;

function betProblem(op: BetSelect, id: string, bet: Bet | null): string | undefined {
  if (bet === null) return `no bet ${id} in ${op.initiative}`;
  if (bet.week !== op.week) return `${id} is a bet for ${bet.week}, not ${op.week}`;
  return bet.state === "proposed" || bet.state === "selected" ? undefined : `${id} is ${bet.state}, so it cannot be selected`;
}

const betLine = (bet: Bet, outcome: Outcome | null): BetLine => ({
  id: bet.id,
  order: bet.order,
  outcome: bet.outcome,
  outcomeStatement: outcome?.statement ?? null,
  prediction: bet.prediction,
  tasks: bet.tasks ?? [],
  selector: bet.selector ?? null,
  state: bet.state,
});

function betSelectReadBack(op: BetSelect, facts: NonNullable<PlanFacts["bets"]>, base: Base): PlanReadBack | string {
  const bets: BetLine[] = [];
  for (const id of op.bets) {
    const fact = facts.find((each) => each.id === id);
    const bet = fact?.bet ?? null;
    const problem = betProblem(op, id, bet);
    if (problem !== undefined || bet === null) return problem ?? `no bet ${id} in ${op.initiative}`;
    bets.push(betLine(bet, fact?.outcome ?? null));
  }
  if (bets.every((bet) => bet.state === "selected")) return `every bet named is already selected for ${op.week}`;
  const effect = `Select ${bets.map((bet) => bet.id).join(", ")} as your bets for ${op.week}; agents plan the week from selected bets only`;
  return { ...base, planOp: "bet-select", initiative: op.initiative, week: op.week, bets, effect };
}

type OutcomeEdit = Extract<PlanOp, { kind: "plan-outcome-edit" }>;

function outcomeEditReadBack(op: OutcomeEdit, outcome: Outcome | null, base: Base): PlanReadBack | string {
  if (outcome === null) return `no outcome ${op.outcome}`;
  const before = { statement: outcome.statement, measure: outcome.measure };
  const after = { ...before, ...op.to };
  const changed = (["statement", "measure"] as const).filter((field) => after[field] !== before[field]);
  if (changed.length === 0) return `${op.outcome} already reads as this edit asks`;
  return { ...base, planOp: "outcome-edit", outcomeId: op.outcome, before, after, effect: `Replace the ${changed.join(" and ")} of ${op.outcome}` };
}

/** When a freeze ends, in words the owner reads on the phone. */
function endsWhen(end: FreezeEndCondition): string {
  switch (end.kind) {
    case "date":
      return `on ${end.date}`;
    case "task-done":
      return `when ${end.task} is done`;
    case "measure":
      return `when ${end.metric} ${end.direction === "increase" ? "rises to" : "falls to"} ${end.threshold}`;
    case "owner":
      return "when you end it";
  }
}

const stopsOf = ({ tag, selector }: { tag?: string; selector?: string }): string => (tag === undefined ? `tasks matching ${selector ?? "?"}` : `tasks tagged ${tag}`);

type FreezeOp = Extract<PlanOp, { kind: "plan-freeze-set" }>;

function freezeReadBack(op: FreezeOp, standing: Freeze | null, base: Base): PlanReadBack | string {
  const { initiative } = op;
  if (op.freeze.action === "set") {
    const { reason, end_condition } = op.freeze;
    if ((op.freeze.tag === undefined) === (op.freeze.selector === undefined)) return "a freeze names exactly one of a tag or a selector";
    const stops = stopsOf(op.freeze);
    const ends = endsWhen(end_condition);
    return { ...base, planOp: "freeze", action: "set", initiative, freezeId: null, stops, reason, ends, effect: `Freeze ${stops} in ${initiative} as yours; it ends ${ends}` };
  }
  if (standing === null) return `no freeze ${op.freeze.id}`;
  if (standing.ended_on !== undefined) return `${standing.id} already ended on ${standing.ended_on}`;
  const stops = stopsOf(standing);
  return { ...base, planOp: "freeze", action: "end", initiative, freezeId: standing.id, stops, reason: standing.reason, ends: endsWhen(standing.end_condition), effect: `End ${standing.id} today; ${stops} may be worked again` };
}

/** An outcome edit carries the before the owner read, so the factory refuses it when the outcome moved since. */
export function postedPlanOp(op: PlanOp, readBack: PlanReadBack): PlanOp {
  if (op.kind !== "plan-outcome-edit" || readBack.planOp !== "outcome-edit") return op;
  return { kind: op.kind, outcome: op.outcome, to: op.to, from: readBack.before };
}

const PLAN_LANDED: Record<PlanOp["kind"], (ids: string) => string> = {
  "plan-bet-select": (ids) => `Selected ${ids}; plan bet list --week now returns them`,
  "plan-outcome-edit": (ids) => `Outcome ${ids} updated`,
  "plan-freeze-set": (ids) => `Freeze ${ids} written as yours`,
};

const isPlanKind = (kind: string): kind is PlanOp["kind"] => Object.hasOwn(PLAN_LANDED, kind);

/** What a landed planning op did, by the kind the factory reports. */
export function planMessageOf(kind: string, ids: string[]): string {
  return isPlanKind(kind) ? PLAN_LANDED[kind](ids.join(", ")) : `Plan updated: ${ids.join(", ")}`;
}
