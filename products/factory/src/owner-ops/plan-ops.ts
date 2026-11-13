import type { OwnerOp } from "@titan-design/owner-queue";
import type { Bet, Freeze } from "@titan-design/pm";
import { loadPlanRecords, nextPlanId, PlanStoreError, readPlanRecord, withPlanLock, writePlanRecord } from "@titan-design/pm/node";
import { refused, type Outcome } from "../console-action/outcome.js";
import type { OpRead } from "../console-action/record.js";
import type { OwnerOpsLedger } from "./ledger.js";

/*
 * The owner's planning actions (TP-5453 P3b): select bets, edit an outcome, set or end a freeze. They write active-work's
 * plan store through pm's one store and lock, and this owner-op apply path is the only code that does: active-work has no
 * CLI verb, RPC method or MCP tool for them. Each re-reads the records under the lock, so a stale tap refuses, never overwrites.
 */

type BetSelect = Extract<OwnerOp, { kind: "plan-bet-select" }>;
type FreezeSet = Extract<OwnerOp, { kind: "plan-freeze-set" }>;

export interface PlanOpDeps {
  /** active-work's data root, the one its own CLI resolves. */
  activeRoot: string;
  ledger: OwnerOpsLedger;
  now: () => number;
}

const applied = (op: OwnerOp, ids: string[]): Outcome => ({ outcome: "plan-applied", op: op.kind, ids });

/** The plan store's refusals as outcomes: a missing initiative is gone, a busy lock passes, an invalid record never will. */
async function underLock(activeRoot: string, initiative: string, fn: () => Promise<Outcome>): Promise<Outcome> {
  try {
    return await withPlanLock(activeRoot, initiative, fn);
  } catch (error) {
    if (!(error instanceof PlanStoreError)) throw error;
    if (error.kind === "not-found") return { outcome: "gone", reason: error.message };
    return refused(error.kind === "lock-timeout" ? "plan-busy" : "record", error.message);
  }
}

function betProblem(op: BetSelect, id: string, bet: Bet | null): string | undefined {
  if (bet === null) return `no bet ${id} in ${op.initiative}`;
  if (bet.week !== op.week) return `${id} is a bet for ${bet.week}, not ${op.week}`;
  if (bet.state !== "proposed" && bet.state !== "selected") return `${id} is ${bet.state} now, so it cannot be selected`;
  return undefined;
}

/** Selects every named bet, or none: one bet missing, of another week, or dropped or done refuses the whole tap. */
export async function selectBets(_actionId: string, { op }: OpRead, deps: PlanOpDeps): Promise<Outcome> {
  if (op.kind !== "plan-bet-select") return refused("record", `plan-bet-select cannot run a ${op.kind} op`);
  return underLock(deps.activeRoot, op.initiative, async () => {
    const bets = await Promise.all(op.bets.map((id) => readPlanRecord(deps.activeRoot, "bet", id)));
    const problem = op.bets.map((id, index) => betProblem(op, id, bets[index] ?? null)).find((each) => each !== undefined);
    if (problem !== undefined) return refused("mismatch", problem);
    const proposed = bets.filter((bet): bet is Bet => bet?.state === "proposed");
    if (proposed.length === 0) return { outcome: "already", ids: op.bets };
    for (const bet of proposed) await writePlanRecord(deps.activeRoot, "bet", { ...bet, state: "selected" });
    return applied(op, op.bets);
  });
}

const initiativeOf = (id: string): string => id.slice(0, id.indexOf("/"));

/** Replaces the statement, the measure or both, only while the outcome still reads as the owner was shown it. */
export async function editOutcome(_actionId: string, { op }: OpRead, deps: PlanOpDeps): Promise<Outcome> {
  if (op.kind !== "plan-outcome-edit") return refused("record", `plan-outcome-edit cannot run a ${op.kind} op`);
  if (op.to.statement === undefined && op.to.measure === undefined) return refused("record", "an outcome edit names no new statement or measure");
  return underLock(deps.activeRoot, initiativeOf(op.outcome), async () => {
    const current = await readPlanRecord(deps.activeRoot, "outcome", op.outcome);
    if (current === null) return { outcome: "gone", reason: `no outcome ${op.outcome}` };
    const moved = op.from !== undefined && (current.statement !== op.from.statement || current.measure !== op.from.measure);
    if (moved) return refused("mismatch", `${op.outcome} changed since it was read back; read it again`);
    const next = { ...current, ...op.to };
    if (next.statement === current.statement && next.measure === current.measure) return { outcome: "already", ids: [op.outcome] };
    await writePlanRecord(deps.activeRoot, "outcome", next);
    return applied(op, [op.outcome]);
  });
}

/** A replay of a set that landed answers with the freeze it wrote, so one tap never sets two freezes. */
async function setBefore(ledger: OwnerOpsLedger, actionId: string): Promise<string[] | undefined> {
  const done = (await ledger.read(actionId)).flatMap((line) => (line.phase === "done" && line.result !== undefined ? [line.result] : []));
  const landed = done.find((result): result is { outcome: "plan-applied"; ids: string[] } => "outcome" in result && result.outcome === "plan-applied");
  return landed?.ids;
}

function ownerFreeze(op: FreezeSet & { freeze: { action: "set" } }, id: string): Freeze {
  const { tag, selector, reason, end_condition, intent_ref, quote_ref } = op.freeze;
  return { id, initiative: op.initiative, tag, selector, reason, end_condition, set_by: "owner", intent_ref, quote_ref };
}

/** Sets a new freeze as the owner's, or ends a standing one on today's date; a freeze is never deleted. */
export async function setFreeze(actionId: string, { op }: OpRead, deps: PlanOpDeps): Promise<Outcome> {
  if (op.kind !== "plan-freeze-set") return refused("record", `plan-freeze-set cannot run a ${op.kind} op`);
  const { activeRoot } = deps;
  if (op.freeze.action === "end") return endFreeze(op.freeze.id, op, deps);
  const before = await setBefore(deps.ledger, actionId);
  if (before !== undefined) return { outcome: "already", ids: before };
  const set = { ...op, freeze: op.freeze };
  return underLock(activeRoot, op.initiative, async () => {
    const id = nextPlanId(op.initiative, "F", await loadPlanRecords(activeRoot, op.initiative, "freeze"));
    await writePlanRecord(activeRoot, "freeze", ownerFreeze(set, id));
    return applied(op, [id]);
  });
}

function endFreeze(id: string, op: FreezeSet, { activeRoot, now }: PlanOpDeps): Promise<Outcome> {
  if (initiativeOf(id) !== op.initiative) return Promise.resolve(refused("record", `${id} is not a freeze of ${op.initiative}`));
  return underLock(activeRoot, op.initiative, async () => {
    const freeze = await readPlanRecord(activeRoot, "freeze", id);
    if (freeze === null) return { outcome: "gone", reason: `no freeze ${id}` };
    if (freeze.ended_on !== undefined) return { outcome: "already", ids: [id] };
    await writePlanRecord(activeRoot, "freeze", { ...freeze, ended_on: new Date(now()).toISOString().slice(0, 10) });
    return applied(op, [id]);
  });
}
