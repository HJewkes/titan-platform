import type { OwnerOpKind } from "@titan-design/owner-queue";
import { opAuthority } from "../owner-ops/authority.js";
import { runLogged, type OwnerOpsLedger } from "../owner-ops/ledger.js";
import { refused, type Outcome } from "./outcome.js";
import type { OpRead } from "./record.js";

export type OpEffect = (read: OpRead) => Promise<Outcome>;
type OpEffects = Readonly<Partial<Record<OwnerOpKind, OpEffect>>>;

/** The ops the console may run, as data: each later slice adds its kind's effect here, and a kind with none is refused. */
export const OP_EFFECTS: OpEffects = Object.freeze({});

export interface OpDeps {
  effects: OpEffects;
  ledger: OwnerOpsLedger;
  now: () => number;
}

/** The authority table decides first, so an op it denies owner-remote never reaches an effect or the ledger. */
export async function actOnOp(actionId: string, read: OpRead, { effects, ledger, now }: OpDeps): Promise<Outcome> {
  const { op } = read;
  const decision = opAuthority(op);
  if (decision.verdict === "deny") return refused("class", `a ${op.kind} op: ${decision.reason}`);
  const effect = effects[op.kind];
  if (effect === undefined) return refused("class", `a ${op.kind} op has no factory effect`);
  return runLogged(ledger, { actionId, op, now }, () => effect(read));
}
