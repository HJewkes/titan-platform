import type { MergeMethod } from "@titan-design/github";
import { z } from "zod";
import type { GateDecision, GatePolicy, PolicyRule } from "../gate-policy.js";
import type { SeatLookup } from "./seats.js";

const MERGE_ORDER = ["never", "owner-gate", "auto"] as const;

export type MergeMode = (typeof MERGE_ORDER)[number];

/** What a registration asks for; each field can only narrow what the seat allows. Unknown keys are refused. */
export const RequestedPolicySchema = z.strictObject({
  merge: z.enum(MERGE_ORDER).optional(),
  mergeMethod: z.enum(["merge", "squash", "rebase"] satisfies MergeMethod[]).optional(),
  reviewer: z.string().regex(/^\S+$/, "must be a non-empty name without whitespace").optional(),
  priority: z.number().int().optional(),
  fixer: z.boolean().optional(),
});

export type RequestedPolicy = z.infer<typeof RequestedPolicySchema>;

export interface EffectivePolicy {
  merge: MergeMode;
  mergeMethod: MergeMethod;
  reviewer?: string;
  priority?: number;
  fixer: boolean;
  /** The seat that set the ceiling, or `none` for a repo no seat lists. */
  seat: string;
}

export class RegistrationRefused extends Error {
  override readonly name = "RegistrationRefused";
}

export const MERGE_ON_GREEN_GRANT = "merge-on-green-approve";
export const SHEPHERD_POLICY_TABLE = "shepherd-seat";

function narrower(a: MergeMode, b: MergeMode): MergeMode {
  return MERGE_ORDER.indexOf(a) <= MERGE_ORDER.indexOf(b) ? a : b;
}

/** The seat default narrowed by the per-PR request; a registration never widens its seat. */
export function resolveEffectivePolicy(lookup: SeatLookup, request: unknown = {}): EffectivePolicy {
  if (lookup.kind === "denied") throw new RegistrationRefused(lookup.reason);
  const requested = parseRequest(request);
  const seat = lookup.kind === "seat" ? lookup.seat : undefined;
  const ceiling: MergeMode = seat?.grants.includes(MERGE_ON_GREEN_GRANT) ? "auto" : "owner-gate";
  return {
    merge: narrower(ceiling, requested.merge ?? ceiling),
    mergeMethod: requested.mergeMethod ?? "squash",
    ...(requested.reviewer !== undefined && { reviewer: requested.reviewer }),
    ...(requested.priority !== undefined && { priority: requested.priority }),
    fixer: seat !== undefined && requested.fixer !== false,
    seat: seat?.name ?? "none",
  };
}

function parseRequest(request: unknown): RequestedPolicy {
  const parsed = RequestedPolicySchema.safeParse(request);
  if (!parsed.success) throw new RegistrationRefused(`invalid policy request: ${parsed.error.issues.map((i) => `${i.path.join(".") || "$"}: ${i.message}`).join("; ")}`);
  return parsed.data;
}

/** `never` denies and everything else gates; T7 (TP-464) turns `auto` into an allow. */
export function shepherdGatePolicy(effective: EffectivePolicy): GatePolicy {
  const rule: PolicyRule = { table: SHEPHERD_POLICY_TABLE, rowId: effective.seat, version: 1 };
  return {
    decide: (action): GateDecision =>
      effective.merge === "never"
        ? { outcome: "deny", rule, reason: `seat ${effective.seat} policy never allows ${action}` }
        : { outcome: "gate", rule, reason: `seat ${effective.seat} policy ${effective.merge} waits for the owner on ${action}` },
  };
}
