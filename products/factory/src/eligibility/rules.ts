import type { Bet, Freeze, OutOfScope, Task } from "@titan-design/pm";

/*
 * The selection policy (operating model PROPOSAL 2.2, TP-5453 P4): which open tasks the dispatcher may take, and in
 * what order. Pure and deterministic; no model call. Back-pressure (PROPOSAL 2.3) is back-pressure.ts.
 */

/** The closed set of reasons a task is refused; one task may carry several. */
type RefusalCode =
  | "no-bet"
  | "bet-not-selected"
  | "no-done-when"
  | "not-in-bet"
  | "no-owner-steps"
  | "no-fold"
  | "frozen"
  | "out-of-scope"
  | "unreadable";

interface Refusal {
  code: RefusalCode;
  detail: string;
}

export interface PlanView {
  initiative: string;
  /** The week's selected bets, in the owner's stated order. */
  bets: readonly Bet[];
  /** Freezes still in force; `freezeActive` in active-work.ts decides which ones are. */
  freezes: readonly Freeze[];
  outOfScope: readonly OutOfScope[];
}

interface EligibleTask {
  task: Task;
  bet: Bet;
}

export interface RefusedTask {
  id: string;
  refusals: Refusal[];
}

export interface Eligibility {
  eligible: EligibleTask[];
  refused: RefusedTask[];
}

const taskKey = (initiative: string, task: Task): string => `${initiative}/${task.id}`;

function betRefusals(task: Task, key: string, bet: Bet | undefined): Refusal[] {
  if (task.bet === undefined) return [{ code: "no-bet", detail: "names no bet" }];
  if (bet === undefined) return [{ code: "bet-not-selected", detail: `${task.bet} is not a selected bet this week` }];
  if (bet.tasks?.includes(key)) return [];
  // A selector has no defined grammar yet, so a bet that only names one approves no task by it.
  const why = bet.tasks === undefined ? `${bet.id} names tasks by selector, which is not evaluated` : `${bet.id} does not list ${key}`;
  return [{ code: "not-in-bet", detail: why }];
}

function freezeApplies(freeze: Freeze, task: Task): boolean {
  // An unevaluated selector is read as covering every task: a freeze fails closed.
  return freeze.tag === undefined || (task.tags ?? []).includes(freeze.tag);
}

function fieldRefusals(task: Task): Refusal[] {
  const refusals: Refusal[] = [];
  if ((task.done_when ?? "").trim() === "") refusals.push({ code: "no-done-when", detail: "has no done_when" });
  if (task.owner_steps === undefined) refusals.push({ code: "no-owner-steps", detail: "owner_steps is absent" });
  if (task.fold === undefined) refusals.push({ code: "no-fold", detail: "fold is not set" });
  return refusals;
}

function planRefusals(task: Task, plan: PlanView): Refusal[] {
  const frozen = plan.freezes
    .filter((freeze) => freezeApplies(freeze, task))
    .map((freeze): Refusal => ({ code: "frozen", detail: `under ${freeze.id}` }));
  const outOfScope = plan.outOfScope
    .filter((record) => (task.tags ?? []).includes(record.id))
    .map((record): Refusal => ({ code: "out-of-scope", detail: `tagged ${record.id}` }));
  return [...frozen, ...outOfScope];
}

/** Every reason the task may not be dispatched under the plan, in rule order; empty when it may. */
function refusalsFor(task: Task, bet: Bet | undefined, plan: PlanView): Refusal[] {
  const key = taskKey(plan.initiative, task);
  return [...betRefusals(task, key, bet), ...fieldRefusals(task), ...planRefusals(task, plan)];
}

const CLASS_RANK = { product: 0, upkeep: 1 } as const;

const classRank = (task: Task): number => (task.class === undefined ? 2 : CLASS_RANK[task.class]);

const idNumber = (id: string): number => Number(id.slice(id.lastIndexOf("-") + 1));

/** The owner's bet order, then product before upkeep, then oldest first; the id breaks any tie. */
function dispatchOrder(a: EligibleTask, b: EligibleTask): number {
  return (
    a.bet.order - b.bet.order ||
    a.bet.id.localeCompare(b.bet.id) ||
    classRank(a.task) - classRank(b.task) ||
    a.task.created.localeCompare(b.task.created) ||
    idNumber(a.task.id) - idNumber(b.task.id)
  );
}

/** Splits candidate tasks into the eligible ones, in dispatch order, and the refused ones with every reason. */
export function evaluateEligibility(tasks: readonly Task[], plan: PlanView): Eligibility {
  const eligible: EligibleTask[] = [];
  const refused: RefusedTask[] = [];
  for (const task of tasks) {
    const bet = plan.bets.find((candidate) => candidate.id === task.bet);
    const refusals = refusalsFor(task, bet, plan);
    if (refusals.length === 0 && bet !== undefined) eligible.push({ task, bet });
    else refused.push({ id: task.id, refusals });
  }
  return { eligible: eligible.sort(dispatchOrder), refused };
}
