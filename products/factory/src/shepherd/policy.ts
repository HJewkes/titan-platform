import { isDeepStrictEqual } from "node:util";
import type { MergeMethod } from "@titan-design/github";
import type { WorkflowContext } from "@titan-design/workflow";
import { z } from "zod";
import type { GateDecision, GatePolicy, PolicyRule } from "../gate-policy.js";
import { stepIdMatches } from "../definition.js";
import { BaseCheckResult } from "../workflows/land-base.js";
import type { OwnerAtHeadRow } from "../owner-at-head.js";
import type { LandOptions } from "../workflows/land.js";
import { headWaits } from "./freeze-wait.js";
import { decideAutoMerge, MERGE_BY_REVIEWER_RULE, type MergeEvidence } from "./merge-facts.js";
import { shownPaths, type VisualBaselines } from "./visual-gate.js";
import { refreshMergeEvidence } from "./merge-settle.js";
import type { PlanApproval } from "./plan-approval.js";
import { proofOnBase, type ProofOnBase } from "./proof-base.js";
import { CiPolicySchema } from "./review-schemas.js";
import type { Verdict } from "./phases.js";
import { escalationReason, type Escalated, type Escalation } from "./route-table.js";
import { FEATURE_BASE_GRANT, MERGE_ON_GREEN_GRANT, RELEASE_MERGE_GRANT, type SeatLookup } from "./seats.js";
import { skillPathsIn } from "./skill-paths.js";
import { isRecord } from "../narrow.js";

const MERGE_ORDER = ["never", "owner-gate", "auto"] as const;

export type MergeMode = (typeof MERGE_ORDER)[number];

export const OWNER_GATE_REASONS = ["gate-2-visual", "g10-security", "proof-fixture", "owner-asked"] as const;

export type OwnerGateReason = (typeof OWNER_GATE_REASONS)[number];

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
  /** The seat's baseline check and files: a head matching `visualPaths` that changes no baseline merges on that check's success. */
  visualBaselines?: VisualBaselines;
  /** The seat's `merge-into-feature-base` grant: the merge may land in a base other than the default branch; absent, it waits for a retarget. */
  featureBase?: true;
  /** The seat's `release-merge` grant: a Version Packages PR may merge on its preflight; absent, the release waits for the owner. */
  release?: "grant";
  /**
   * The owner's plan approvals this run claimed, attached by each `sh-policy` read and never stored or taken from a run
   * param: `EffectivePolicySchema` refuses the key, so only the store's console-written rows reach the guard.
   */
  approved?: PlanApproval[];
}

/** An `EffectivePolicy` read back from a run param or the store; unknown keys, `approved` among them, are refused. */
export const EffectivePolicySchema: z.ZodType<EffectivePolicy> = z.strictObject({
  merge: z.enum(MERGE_ORDER),
  mergeMethod: z.enum(["merge", "squash", "rebase"] satisfies MergeMethod[]),
  reviewer: z.string().optional(),
  priority: z.number().int().optional(),
  fixer: z.boolean(),
  ownerGateReason: z.enum(OWNER_GATE_REASONS).optional(),
  seat: z.string(),
  visualPaths: z.array(z.string()).optional(),
  visualBaselines: z.strictObject({ check: z.string(), paths: z.array(z.string()) }).optional(),
  featureBase: z.literal(true).optional(),
  release: z.literal("grant").optional(),
});

/** What a repo no seat lists resolves to: the owner gates every merge. */
export const OWNER_GATE_POLICY: EffectivePolicy = { merge: "owner-gate", mergeMethod: "squash", fixer: false, seat: "none" };

/** The ceiling a run carries in its `policy` param; a run with none gets the owner gate. */
export function runPolicyCeiling(rawPolicy: string | undefined): EffectivePolicy {
  return rawPolicy === undefined ? OWNER_GATE_POLICY : EffectivePolicySchema.parse(JSON.parse(rawPolicy));
}

export class RegistrationRefused extends Error {
  override readonly name = "RegistrationRefused";
}

export { FEATURE_BASE_GRANT, MERGE_ON_GREEN_GRANT, RELEASE_MERGE_GRANT };
export const SHEPHERD_POLICY_TABLE = "shepherd-seat";

function narrower(a: MergeMode, b: MergeMode): MergeMode {
  return MERGE_ORDER.indexOf(a) <= MERGE_ORDER.indexOf(b) ? a : b;
}

/**
 * The seat default narrowed by the per-PR request; a registration never widens its seat. A seat with visual paths
 * reaches `auto` without the merge grant, and its visual paths then gate each head that touches one. Only a seat's
 * grant allows a feature base or a release merge; no request key does.
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
    ...(seat?.visualPaths && seat.visualBaselines && { visualBaselines: seat.visualBaselines }),
    ...(seat?.grants.includes(FEATURE_BASE_GRANT) && { featureBase: true as const }),
    ...(seat?.grants.includes(RELEASE_MERGE_GRANT) && { release: "grant" as const }),
  };
}

/**
 * `trusted` narrowed by `other`: an inherited or untrusted policy can tighten the merge mode, add visual paths or drop a
 * feature base, release grant or visual baselines, never loosen any. Baselines clear visual heads, so they survive only
 * when both sides carry the same ones; a run stored before the field has none and keeps the glob gate. Plan approvals
 * clear guard rows, so they follow the same rule.
 */
export function stricterPolicy(trusted: EffectivePolicy, other: EffectivePolicy): EffectivePolicy {
  const merge = narrower(trusted.merge, other.merge);
  const visualPaths = trusted.visualPaths || other.visualPaths ? [...new Set([...(trusted.visualPaths ?? []), ...(other.visualPaths ?? [])])] : undefined;
  const ownerGateReason = trusted.ownerGateReason ?? other.ownerGateReason;
  const stricter: EffectivePolicy = { ...trusted, merge, ...(ownerGateReason && { ownerGateReason }), fixer: trusted.fixer && other.fixer, seat: merge === trusted.merge ? trusted.seat : other.seat, ...(visualPaths && { visualPaths }) };
  if (!other.featureBase) delete stricter.featureBase;
  if (other.release !== "grant") delete stricter.release;
  if (!isDeepStrictEqual(trusted.visualBaselines, other.visualBaselines)) delete stricter.visualBaselines;
  if (!isDeepStrictEqual(trusted.approved, other.approved)) delete stricter.approved;
  return stricter;
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
      if (effective.merge === "auto" && action === "merge" && target?.headSha !== undefined) {
        return decideAutoMerge(target.headSha, mergeEvidenceAt(target.headSha, verdictFor), effective.visualPaths, effective.visualBaselines, effective.approved);
      }
      return { outcome: "gate", rule, reason: `seat ${effective.seat} policy ${effective.merge}${reasonNote(effective)} waits for the owner on ${action}${reviewNote(target?.headSha, verdictFor)}${skillNote(target?.headSha, verdictFor)}` };
    },
  };
}

/**
 * The Shepherd land options: the policy read at each decision, and on an allow the evidence record the PR comment carries.
 * Every gate names why the owner is asked: the escalation at that head, else a policy that did not allow the merge. An
 * unsettled mergeability, a freeze alone or missing facts waits and re-reads the evidence at the same head (freeze-wait.ts),
 * and later decisions about that review judge the re-read.
 */
export function shepherdLandOptions(
  effective: () => EffectivePolicy,
  verdictFor: (headSha: string) => Verdict | undefined = () => undefined,
  escalationAt: (headSha: string) => Escalated | undefined = () => undefined,
  decidedBase: () => string | undefined = () => undefined,
): LandOptions {
  const reread = new WeakMap<Verdict, unknown>();
  const current = (headSha: string): Verdict | undefined => {
    const verdict = verdictFor(headSha);
    return verdict?.kind === "MERGE" && reread.has(verdict) ? { ...verdict, evidence: reread.get(verdict) } : verdict;
  };
  const proof = proofOnBase((headSha) => mergeEvidenceAt(headSha, current));
  const refresh = async (ctx: WorkflowContext, headSha: string): Promise<void> => {
    await rereadEvidence(ctx, headSha, { verdictFor, current, reread }, effective());
    await proof.reread(ctx, headSha, decidedBase());
  };
  const decide = (action: string, target?: { headSha?: string }): GateDecision => {
    const decision = onDecidedBase(shepherdGatePolicy(effective(), current).decide(action, target), target?.headSha, decidedBase(), current, proof);
    if (decision.outcome === "deny") return decision;
    const escalated = target?.headSha === undefined ? undefined : escalationAt(target.headSha);
    if (escalated !== undefined && target?.headSha !== undefined && clearedByFreshMerge(escalated, decision, target.headSha, current)) return clearedDecision(escalated, decision, target.headSha);
    // Any other carried escalation gates even a head the policy would allow: only a fresh review at the head answers it.
    if (escalated !== undefined && (decision.outcome === "gate" || escalated.carriedFrom !== undefined)) return { outcome: "gate", rule: routeRule(escalated.escalation), reason: escalatedReason(escalated, target?.headSha, current) };
    if (decision.outcome !== "gate") return decision;
    return { ...decision, reason: escalationReason("policy-denial", decision.reason) };
  };
  const allowEvidence = (merge: { headSha: string }) => ({ ...mergeEvidenceAt(merge.headSha, current)?.record });
  return { policy: { decide }, allowEvidence, unsettled: headWaits(refresh), featureBase: () => effective().featureBase === true, evidenceBase: (headSha) => mergeEvidenceAt(headSha, current)?.record.baseRef, readOn: proof.readIfUnread, skillPathsAt: (headSha) => skillPathsAt(headSha, current), ownerAtHeadAt: (headSha) => ownerAtHeadAt(headSha, current) };
}

interface Reviews {
  verdictFor: (headSha: string) => Verdict | undefined;
  current: (headSha: string) => Verdict | undefined;
  reread: WeakMap<Verdict, unknown>;
}

/** The MERGE evidence at the head read again, so later decisions about that review judge the re-read. */
async function rereadEvidence(ctx: WorkflowContext, headSha: string, reviews: Reviews, visual: Pick<EffectivePolicy, "visualPaths" | "visualBaselines">): Promise<void> {
  const verdict = reviews.verdictFor(headSha);
  const evidence = mergeEvidenceAt(headSha, reviews.current);
  if (verdict && evidence) reviews.reread.set(verdict, await refreshMergeEvidence(ctx, evidence, visual));
}

/**
 * A decision on evidence read on another base than the one being decided gates: a retarget and back during the re-read
 * could otherwise merge on the other base's review rules and merge tree. So does a fix-proof that judged another base,
 * or proved none, until a read on this one proves the head. An allow and a mechanical MRG-AU gate a coordinator may resolve
 * become no-facts; any other gate keeps its rule and names the off-base proof first. Evidence with no base, or a decision with
 * no checked base, is left as it is.
 */
function onDecidedBase(decision: GateDecision, headSha: string | undefined, base: string | undefined, verdictFor: (headSha: string) => Verdict | undefined, proof: ProofOnBase): GateDecision {
  if (decision.outcome === "deny" || base === undefined || headSha === undefined) return decision;
  const evidenceBase = mergeEvidenceAt(headSha, verdictFor)?.record.baseRef;
  const factsElsewhere = evidenceBase !== undefined && evidenceBase !== base;
  const offBase = factsElsewhere ? `the merge facts at ${headSha} were read on base ${evidenceBase}, not on ${base}, the base being decided` : proof.unproven(headSha, base);
  if (offBase === undefined) return decision;
  if (decision.outcome === "gate" && !isAutoMergeRule(decision.rule)) return { ...decision, reason: `${offBase}; ${decision.reason}` };
  const reason = decision.outcome === "gate" ? `${offBase}; ${decision.reason}` : offBase;
  return { outcome: "gate", rule: { table: "shepherd-merge-guard", rowId: "no-facts", version: 1 }, reason };
}

/**
 * The MRG-AU rows a coordinator may resolve mechanically; off the decided base they become no-facts. Every other gate keeps its own
 * rule, so the visual-path packet, the D21 owner-at-head row and the decision class still key on it.
 */
const isAutoMergeRule = (rule: PolicyRule): boolean => rule.table === "authority" && rule.rowId.startsWith("MRG-AU");

function escalatedReason(escalated: Escalated, headSha: string | undefined, verdictFor: (headSha: string) => Verdict | undefined): string {
  const reason = escalationReason(escalated.escalation, escalated.detail, escalated.words);
  return escalated.carriedFrom === undefined ? reason : `${reason}; carried from the gate at head ${escalated.carriedFrom}${reviewNote(headSha, verdictFor)}`;
}

const routeRule = (rowId: string): PolicyRule => ({ table: "shepherd-route", rowId, version: 1 });

/** Escalations about the review loop, which a later reviewer's MERGE answers; any other carried escalation still asks the owner. */
const CLEARED_BY_MERGE: ReadonlySet<Escalation> = new Set(["fix-first-runaway", "no-progress", "conflict"]);

/**
 * Owner decision 303: a carried review-loop escalation stops gating once the dispatched reviewer writes a MERGE at exactly
 * this head and MRG-AU-RV allows it there. A MERGE carried by tree, remerge or merge-up is not a review of this head.
 */
function clearedByFreshMerge(escalated: Escalated, decision: GateDecision, headSha: string, verdictFor: (headSha: string) => Verdict | undefined): boolean {
  if (escalated.carriedFrom === undefined || !CLEARED_BY_MERGE.has(escalated.escalation)) return false;
  if (decision.outcome !== "allow" || decision.rule.table !== "authority" || decision.rule.rowId !== MERGE_BY_REVIEWER_RULE) return false;
  const verdict = verdictFor(headSha);
  const evidence = mergeEvidenceAt(headSha, verdictFor);
  if (verdict?.kind !== "MERGE" || verdict.mergeUpFrom !== undefined || !evidence) return false;
  return evidence.record.head === headSha && evidence.merge.verdict.head === headSha && evidence.merge.carry === undefined && evidence.record.carry === undefined;
}

function clearedDecision(escalated: Escalated, decision: GateDecision, headSha: string): GateDecision {
  const reason = `${decision.reason}; the ${escalated.escalation} escalation carried from head ${escalated.carriedFrom} is cleared by the dispatched reviewer's MERGE at head ${headSha}`;
  return { outcome: "allow", rule: routeRule(`${escalated.escalation}/cleared-by-merge`), reason };
}

/**
 * The base land's last `base-check` read. A live decision always follows its own check of the base, so this is the base
 * it judges; a replayed decision is the recorded one, whatever this holds.
 */
export function checkedBaseTap(): { base: () => string | undefined; tapping: (ctx: WorkflowContext) => WorkflowContext } {
  let checked: string | undefined;
  const tapping = (ctx: WorkflowContext): WorkflowContext => ({
    ...ctx,
    dispatch: async (stepId, template, options) => {
      const done = await ctx.dispatch(stepId, template, options);
      if (stepIdMatches("base-check", stepId)) checked = BaseCheckResult.safeParse(done.data?.result).data?.base;
      return done;
    },
  });
  return { base: () => checked, tapping };
}

/** A guard, not a zod parse: `decideOnFacts` reads `carry` and the rest of the stored evidence, and a parse would strip them. */
function isMergeEvidence(value: unknown): value is MergeEvidence {
  if (!isRecord(value)) return false;
  const { head, merge, record, changedFilesUnread } = value;
  return typeof head === "string" && isRecord(merge) && Array.isArray(merge.changedPaths) && isRecord(record) && (changedFilesUnread === undefined || typeof changedFilesUnread === "string");
}

/** The evidence a MERGE review carries; a malformed one reads as none, so the merge gates. */
export function mergeEvidenceAt(headSha: string, verdictFor: (headSha: string) => Verdict | undefined): MergeEvidence | undefined {
  const verdict = verdictFor(headSha);
  if (verdict?.kind !== "MERGE") return undefined;
  const stored: unknown = verdict.evidence;
  if (!isMergeEvidence(stored)) return undefined;
  // Only an absent line parses to undefined, so the stored evidence is returned as it is in that case.
  const ciPolicy = CiPolicySchema.parse(stored.ciPolicy);
  return ciPolicy ? { ...stored, ciPolicy } : stored;
}

function reviewNote(headSha: string | undefined, verdictFor: (headSha: string) => Verdict | undefined): string {
  const verdict = headSha === undefined ? undefined : verdictFor(headSha);
  return verdict ? `; review at this head: ${verdict.kind}` : "";
}

/** Read from the MERGE evidence at that head; a head with no well-formed evidence names none. */
export function skillPathsAt(headSha: string, verdictFor: (headSha: string) => Verdict | undefined): string[] {
  return skillPathsIn(mergeEvidenceAt(headSha, verdictFor)?.merge.changedPaths ?? []);
}

/**
 * The D21 facts the MERGE evidence at this head holds, whatever rule the gate opens under; land reads a skill change from
 * `skillPathsAt`. An owner-gate seat never runs the merge guard, and the guard's first row wins over the rest
 * (merge-facts.ts), so a visual-path or files-unread gate can carry a weakened CI policy too. A MERGE whose evidence is
 * malformed read no files the owner can trust, so it reads as unread.
 */
export function ownerAtHeadAt(headSha: string, verdictFor: (headSha: string) => Verdict | undefined): OwnerAtHeadRow[] {
  const evidence = mergeEvidenceAt(headSha, verdictFor);
  if (evidence === undefined) return verdictFor(headSha)?.kind === "MERGE" ? ["files-unread"] : [];
  const rows: OwnerAtHeadRow[] = [];
  if (evidence.ciPolicy?.kind === "weakened") rows.push("ci-policy-weakened");
  if (evidence.ciPolicy?.kind === "malformed") rows.push("ci-policy-malformed");
  if (evidence.changedFilesUnread !== undefined) rows.push("files-unread");
  return rows;
}

function skillNote(headSha: string | undefined, verdictFor: (headSha: string) => Verdict | undefined): string {
  const skills = headSha === undefined ? [] : skillPathsAt(headSha, verdictFor);
  return skills.length > 0 ? `; repo skill changes: ${shownPaths(skills)}` : "";
}

function reasonNote(effective: EffectivePolicy): string {
  return effective.merge === "owner-gate" && effective.ownerGateReason ? ` (${effective.ownerGateReason})` : "";
}
