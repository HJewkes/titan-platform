import type { OwnerOpKind } from "@titan-design/owner-queue";
import { opAuthority } from "../owner-ops/authority.js";
import { runLogged, type OwnerOpsLedger } from "../owner-ops/ledger.js";
import { mergeAtHead, type MergeAtHeadDeps } from "../owner-ops/merge-at-head.js";
import { refused, type Outcome } from "./outcome.js";
import type { OpRead } from "./record.js";

/** What an effect may read and write: the host, GitHub, Shepherd's store and freezes, and the standing answers. */
type OpContext = MergeAtHeadDeps;
export type OpEffect<C = OpContext> = (actionId: string, read: OpRead, context: C) => Promise<Outcome>;
type OpEffects<C = OpContext> = Readonly<Partial<Record<OwnerOpKind, OpEffect<C>>>>;

/** The ops the console may run, as data: each later slice adds its kind's effect here, and a kind with none is refused. */
export const OP_EFFECTS: OpEffects = Object.freeze({ "merge-at-head": mergeAtHead });

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
