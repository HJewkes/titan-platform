import type { OwnerOpKind } from "@titan-design/owner-queue";
import { opAuthority } from "../owner-ops/authority.js";
import { closePr, type ClosePrDeps } from "../owner-ops/close-pr.js";
import { runLogged, type OwnerOpsLedger } from "../owner-ops/ledger.js";
import { mergeAtHead, type MergeAtHeadDeps } from "../owner-ops/merge-at-head.js";
import { clearPause, type PauseClearDeps } from "../owner-ops/pause-clear.js";
import { editOutcome, selectBets, setFreeze, type PlanOpDeps } from "../owner-ops/plan-ops.js";
import { retireAgent, type RetireAgentDeps } from "../owner-ops/retire-agent.js";
import { refused, type Outcome } from "./outcome.js";
import type { OpRead } from "./record.js";

/** What an effect may read and write: the host, GitHub, Shepherd's store and freezes, the standing answers, the ledger, agent-chat, the deploy state and active-work's plan store. */
type OpContext = MergeAtHeadDeps & ClosePrDeps & RetireAgentDeps & PauseClearDeps & PlanOpDeps;
export type OpEffect<C = OpContext> = (actionId: string, read: OpRead, context: C) => Promise<Outcome>;
type OpEffects<C = OpContext> = Readonly<Partial<Record<OwnerOpKind, OpEffect<C>>>>;

/** The ops the console may run, as data: each later slice adds its kind's effect here, and a kind with none is refused. */
export const OP_EFFECTS: OpEffects = Object.freeze({
  "merge-at-head": mergeAtHead,
  "retire-agent": retireAgent,
  "close-pr": closePr,
  "deploy-pause-clear": clearPause,
  "plan-bet-select": selectBets,
  "plan-outcome-edit": editOutcome,
  "plan-freeze-set": setFreeze,
});

export interface OpDeps<C = OpContext> {
  effects: OpEffects<C>;
  ledger: OwnerOpsLedger;
  now: () => number;
}

/** The authority table decides first, so an op it denies owner-remote never reaches an effect or the ledger. */
export async function actOnOp<C>(actionId: string, read: OpRead, { effects, ledger, now }: OpDeps<C>, context: C): Promise<Outcome> {
  const { op } = read;
  const decision = opAuthority(op);
  if (decision.verdict === "deny") return refused("class", `a ${op.kind} op: ${decision.reason}`);
  const effect = effects[op.kind];
  if (effect === undefined) return refused("class", `a ${op.kind} op has no factory effect`);
  return runLogged(ledger, { actionId, op, now }, () => effect(actionId, read, context));
}
