import type { MergeMethod } from "@titan-design/github";
import type { WorkflowContext } from "@titan-design/workflow";
import { z } from "zod";
import type { GateDecision, GatePolicy, PolicyRule } from "../gate-policy.js";
import type { LandOptions } from "../workflows/land.js";
import { decideAutoMerge, isUnsettledGate, type MergeEvidence } from "./merge-facts.js";
import { refreshMergeEvidence } from "./merge-settle.js";
import type { Verdict } from "./phases.js";
import { escalationReason, type Escalated } from "./route-table.js";
import { MERGE_ON_GREEN_GRANT, type SeatLookup } from "./seats.js";

const MERGE_ORDER = ["never", "owner-gate", "auto"] as const;

export type MergeMode = (typeof MERGE_ORDER)[number];

export const OWNER_GATE_REASONS = ["gate-2-visual", "g10-security", "proof-fixture", "owner-asked"] as const;

type OwnerGateReason = (typeof OWNER_GATE_REASONS)[number];

/** The request's fields alone, so an argument parser accepts a request that `resolveEffectivePolicy` then refuses as a registration. */
export const RequestedPolicyFields = z.strictObject({
  merge: z.enum(MERGE_ORDER).optional(),
  ownerGateReason: z.enum(OWNER_GATE_REASONS).optional(),
  mergeMethod: z.enum(["merge", "squash", "rebase"] satisfies MergeMethod[]).optional(),
  reviewer: z.string().regex(/^\S+$/, "must be a non-empty name without whitespace").optional(),
  priority: z.number().int().optional(),
  fixer: z.boolean().optional(),
});

/** What a registration asks for; each field can only narrow what the seat allows. Unknown keys are refused, and owner-gate must say why. */
const RequestedPolicySchema = RequestedPolicyFields.superRefine((request, ctx) => {
  const path = ["ownerGateReason"];
  if (request.merge === "owner-gate" && request.ownerGateReason === undefined) {
    ctx.addIssue({ code: "custom", path, message: `owner-gate needs ownerGateReason, one of ${OWNER_GATE_REASONS.join(", ")}` });
  }
  if (request.merge !== "owner-gate" && request.ownerGateReason !== undefined) ctx.addIssue({ code: "custom", path, message: "ownerGateReason applies only with merge owner-gate" });
});

export type RequestedPolicy = z.infer<typeof RequestedPolicySchema>;

export interface EffectivePolicy {
  merge: MergeMode;
  mergeMethod: MergeMethod;
  reviewer?: string;
  priority?: number;
  fixer: boolean;
  /** Why the owner is asked; absent on an owner-gate run registered before the field, which reads as legacy. */
  ownerGateReason?: OwnerGateReason;
  /** The seat that set the ceiling, or `none` for a repo no seat lists. */
  seat: string;
  /** Under `auto`, a head whose changed files match one of these globs still waits for the owner. */
  visualPaths?: string[];
}

/** An `EffectivePolicy` read back from a run param or the store; unknown keys are refused. */
export const EffectivePolicySchema: z.ZodType<EffectivePolicy> = z.strictObject({
  merge: z.enum(MERGE_ORDER),
  mergeMethod: z.enum(["merge", "squash", "rebase"] satisfies MergeMethod[]),
  reviewer: z.string().optional(),
  priority: z.number().int().optional(),
  fixer: z.boolean(),
  ownerGateReason: z.enum(OWNER_GATE_REASONS).optional(),
  seat: z.string(),
  visualPaths: z.array(z.string()).optional(),
});

/** What a repo no seat lists resolves to: the owner gates every merge. */
export const OWNER_GATE_POLICY: EffectivePolicy = { merge: "owner-gate", mergeMethod: "squash", fixer: false, seat: "none" };

export class RegistrationRefused extends Error {
  override readonly name = "RegistrationRefused";
}

export { MERGE_ON_GREEN_GRANT };
export const SHEPHERD_POLICY_TABLE = "shepherd-seat";

function narrower(a: MergeMode, b: MergeMode): MergeMode {
  return MERGE_ORDER.indexOf(a) <= MERGE_ORDER.indexOf(b) ? a : b;
}

/**
 * The seat default narrowed by the per-PR request; a registration never widens its seat. A seat with visual paths
 * reaches `auto` without the merge grant, and its visual paths then gate each head that touches one.
 */
export function resolveEffectivePolicy(lookup: SeatLookup, request: unknown = {}): EffectivePolicy {
  if (lookup.kind === "denied") throw new RegistrationRefused(lookup.reason);
  const requested = parseRequest(request);
  const seat = lookup.kind === "seat" ? lookup.seat : undefined;
  const ceiling: MergeMode = seat?.grants.includes(MERGE_ON_GREEN_GRANT) || seat?.visualPaths !== undefined ? "auto" : "owner-gate";
  return {
    merge: narrower(ceiling, requested.merge ?? ceiling),
    mergeMethod: requested.mergeMethod ?? "squash",
    ...(requested.reviewer !== undefined && { reviewer: requested.reviewer }),
    ...(requested.priority !== undefined && { priority: requested.priority }),
    fixer: seat !== undefined && requested.fixer !== false,
    ...(requested.ownerGateReason !== undefined && { ownerGateReason: requested.ownerGateReason }),
    seat: seat?.name ?? "none",
    ...(seat?.visualPaths && { visualPaths: seat.visualPaths }),
  };
}

/** `trusted` narrowed by `other`: an inherited or untrusted policy can tighten the merge mode or add visual paths, never loosen either. */
export function stricterPolicy(trusted: EffectivePolicy, other: EffectivePolicy): EffectivePolicy {
  const merge = narrower(trusted.merge, other.merge);
  const visualPaths = trusted.visualPaths || other.visualPaths ? [...new Set([...(trusted.visualPaths ?? []), ...(other.visualPaths ?? [])])] : undefined;
  const ownerGateReason = trusted.ownerGateReason ?? other.ownerGateReason;
  return { ...trusted, merge, ...(ownerGateReason && { ownerGateReason }), fixer: trusted.fixer && other.fixer, seat: merge === trusted.merge ? trusted.seat : other.seat, ...(visualPaths && { visualPaths }) };
}

/** A repeat registration narrows the stored policy, but the first owner-gate reason stands: a repeat cannot relabel why the owner is asked. */
export function repeatedPolicy(repeat: EffectivePolicy, stored: EffectivePolicy): EffectivePolicy {
  const narrowed = stricterPolicy(repeat, stored);
  const ownerGateReason = stored.ownerGateReason ?? narrowed.ownerGateReason;
  return { ...narrowed, ...(ownerGateReason && { ownerGateReason }) };
}

function parseRequest(request: unknown): RequestedPolicy {
  const parsed = RequestedPolicySchema.safeParse(request);
  if (!parsed.success) throw new RegistrationRefused(`invalid policy request: ${parsed.error.issues.map((i) => `${i.path.join(".") || "$"}: ${i.message}`).join("; ")}`);
  return parsed.data;
}

/**
 * `never` denies and `owner-gate` gates. `auto` allows a merge only when authority's MRG-AU-RV holds on the merge facts
 * the MERGE review collected at the exact head being decided, and none of those facts' changed files is visual; anything
 * else gates. `verdictFor` is the review taken at that head.
 */
export function shepherdGatePolicy(effective: EffectivePolicy, verdictFor: (headSha: string) => Verdict | undefined = () => undefined): GatePolicy {
  const rule: PolicyRule = { table: SHEPHERD_POLICY_TABLE, rowId: effective.seat, version: 1 };
  return {
    decide: (action, target): GateDecision => {
      if (effective.merge === "never") return { outcome: "deny", rule, reason: `seat ${effective.seat} policy never allows ${action}` };
      if (effective.merge === "auto" && action === "merge" && target?.headSha !== undefined) return decideAutoMerge(target.headSha, mergeEvidenceAt(target.headSha, verdictFor), effective.visualPaths);
      return { outcome: "gate", rule, reason: `seat ${effective.seat} policy ${effective.merge}${reasonNote(effective)} waits for the owner on ${action}${reviewNote(target?.headSha, verdictFor)}` };
    },
  };
}

/**
 * The Shepherd land options: the policy read at each decision, and on an allow the evidence record the PR comment carries.
 * Every gate names why the owner is asked: the escalation at that head, else a policy that did not allow the merge. An
 * unsettled mergeability re-reads the evidence at the same head, and later decisions about that review judge the re-read.
 */
export function shepherdLandOptions(
  effective: () => EffectivePolicy,
  verdictFor: (headSha: string) => Verdict | undefined = () => undefined,
  escalationAt: (headSha: string) => Escalated | undefined = () => undefined,
): LandOptions {
  const reread = new WeakMap<Verdict, unknown>();
  const current = (headSha: string): Verdict | undefined => {
    const verdict = verdictFor(headSha);
    return verdict?.kind === "MERGE" && reread.has(verdict) ? { ...verdict, evidence: reread.get(verdict) } : verdict;
  };
  const refresh = async (ctx: WorkflowContext, headSha: string): Promise<void> => {
    const verdict = verdictFor(headSha);
    const evidence = mergeEvidenceAt(headSha, current);
    if (verdict && evidence) reread.set(verdict, await refreshMergeEvidence(ctx, evidence, effective().visualPaths));
  };
  const decide = (action: string, target?: { headSha?: string }): GateDecision => {
    const decision = shepherdGatePolicy(effective(), current).decide(action, target);
    if (decision.outcome !== "gate") return decision;
    const escalated = target?.headSha === undefined ? undefined : escalationAt(target.headSha);
    if (escalated !== undefined) return { outcome: "gate", rule: routeRule(escalated.escalation), reason: escalationReason(escalated.escalation, escalated.detail) };
    return { ...decision, reason: escalationReason("policy-denial", decision.reason) };
  };
  return { policy: { decide }, allowEvidence: (merge) => ({ ...mergeEvidenceAt(merge.headSha, current)?.record }), unsettled: { transient: isUnsettledGate, refresh } };
}

const routeRule = (rowId: string): PolicyRule => ({ table: "shepherd-route", rowId, version: 1 });

/** The evidence a MERGE review carries; a malformed one reads as none, so the merge gates. */
function mergeEvidenceAt(headSha: string, verdictFor: (headSha: string) => Verdict | undefined): MergeEvidence | undefined {
  const verdict = verdictFor(headSha);
  if (verdict?.kind !== "MERGE") return undefined;
  const evidence = verdict.evidence as Partial<MergeEvidence> | null | undefined;
  const wellFormed =
    typeof evidence?.head === "string" &&
    typeof evidence.merge === "object" &&
    evidence.merge !== null &&
    Array.isArray(evidence.merge.changedPaths) &&
    typeof evidence.record === "object" &&
    evidence.record !== null &&
    (evidence.changedFilesUnread === undefined || typeof evidence.changedFilesUnread === "string");
  return wellFormed ? (evidence as MergeEvidence) : undefined;
}

function reviewNote(headSha: string | undefined, verdictFor: (headSha: string) => Verdict | undefined): string {
  const verdict = headSha === undefined ? undefined : verdictFor(headSha);
  return verdict ? `; review at this head: ${verdict.kind}` : "";
}

function reasonNote(effective: EffectivePolicy): string {
  return effective.merge === "owner-gate" && effective.ownerGateReason ? ` (${effective.ownerGateReason})` : "";
}
