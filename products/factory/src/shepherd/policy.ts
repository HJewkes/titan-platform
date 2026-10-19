import type { MergeMethod } from "@titan-design/github";
import type { WorkflowContext } from "@titan-design/workflow";
import { z } from "zod";
import type { GateDecision, GatePolicy, PolicyRule } from "../gate-policy.js";
import { stepIdMatches } from "../definition.js";
import { BaseCheckResult } from "../workflows/land-base.js";
import type { LandOptions } from "../workflows/land.js";
import { ALLOWED_CHECK_APPS, decideAutoMerge, isUnsettledGate, MERGE_BY_REVIEWER_RULE, type MergeEvidence } from "./merge-facts.js";
import { VISUAL_DEMOTION_NOTE, type VisualDemotion } from "./auto-pass.js";
import { shownPaths, visualDemotionAt } from "./visual-gate.js";
import { refreshMergeEvidence } from "./merge-settle.js";
import { CiPolicySchema } from "./review-schemas.js";
import type { Verdict } from "./phases.js";
import { escalationReason, type Escalated, type Escalation } from "./route-table.js";
import { FEATURE_BASE_GRANT, MERGE_ON_GREEN_GRANT, RELEASE_MERGE_GRANT, type SeatLookup } from "./seats.js";
import { skillPathsIn } from "./skill-paths.js";

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
  /** The seat's `merge-into-feature-base` grant: the merge may land in a base other than the default branch; absent, it waits for a retarget. */
  featureBase?: true;
  /** The seat's `release-merge` grant: a Version Packages PR may merge on its preflight; absent, the release waits for the owner. */
  release?: "grant";
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
    ...(seat?.grants.includes(FEATURE_BASE_GRANT) && { featureBase: true as const }),
    ...(seat?.grants.includes(RELEASE_MERGE_GRANT) && { release: "grant" as const }),
  };
}

/** `trusted` narrowed by `other`: an inherited or untrusted policy can tighten the merge mode, add visual paths or drop a feature base or release grant, never loosen any. */
export function stricterPolicy(trusted: EffectivePolicy, other: EffectivePolicy): EffectivePolicy {
  const merge = narrower(trusted.merge, other.merge);
  const visualPaths = trusted.visualPaths || other.visualPaths ? [...new Set([...(trusted.visualPaths ?? []), ...(other.visualPaths ?? [])])] : undefined;
  const ownerGateReason = trusted.ownerGateReason ?? other.ownerGateReason;
  const stricter: EffectivePolicy = { ...trusted, merge, ...(ownerGateReason && { ownerGateReason }), fixer: trusted.fixer && other.fixer, seat: merge === trusted.merge ? trusted.seat : other.seat, ...(visualPaths && { visualPaths }) };
  if (!other.featureBase) delete stricter.featureBase;
  if (other.release !== "grant") delete stricter.release;
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
 * else gates. `verdictFor` is the review taken at that head. `visualDemotion` is the D2 guard `seatVisualDemotion` built
 * for the repo; absent, every visual gate waits for the owner.
 */
export function shepherdGatePolicy(
  effective: EffectivePolicy,
  verdictFor: (headSha: string) => Verdict | undefined = () => undefined,
  visualDemotion: VisualDemotion | null = null,
): GatePolicy {
  const rule: PolicyRule = { table: SHEPHERD_POLICY_TABLE, rowId: effective.seat, version: 1 };
  return {
    decide: (action, target): GateDecision => {
      if (effective.merge === "never") return { outcome: "deny", rule, reason: `seat ${effective.seat} policy never allows ${action}` };
      const headSha = action === "merge" ? target?.headSha : undefined;
      if (effective.merge === "auto" && headSha !== undefined) return decideAutoMerge(headSha, mergeEvidenceAt(headSha, verdictFor), { visualPaths: effective.visualPaths, visualDemotion });
      const passed = headSha === undefined ? undefined : gate2VisualPass(effective, headSha, verdictFor, visualDemotion);
      if (passed) return passed;
      return { outcome: "gate", rule, reason: `seat ${effective.seat} policy ${effective.merge}${reasonNote(effective)} waits for the owner on ${action}${reviewNote(target?.headSha, verdictFor)}${skillNote(target?.headSha, verdictFor)}` };
    },
  };
}

/**
 * D2 (TP-3697): a gate-2-visual registration on a seat with visual paths, whose ceiling is therefore auto, merges without
 * the owner when the auto decision allows at the head and the D2 guard holds there, whether or not a visual glob matched.
 */
function gate2VisualPass(effective: EffectivePolicy, headSha: string, verdictFor: (headSha: string) => Verdict | undefined, demotion: VisualDemotion | null): GateDecision | undefined {
  if (demotion === null || effective.ownerGateReason !== "gate-2-visual" || effective.visualPaths === undefined) return undefined;
  const evidence = mergeEvidenceAt(headSha, verdictFor);
  const decision = decideAutoMerge(headSha, evidence, { visualPaths: effective.visualPaths, visualDemotion: demotion });
  if (decision.outcome !== "allow" || evidence === undefined) return undefined;
  const read = visualDemotionAt(evidence.merge, demotion, ALLOWED_CHECK_APPS);
  if (!read.holds) return undefined;
  const note = decision.reason.includes(VISUAL_DEMOTION_NOTE) ? "" : `${VISUAL_DEMOTION_NOTE}: ${read.evidence.join("; ")}`;
  return { ...decision, reason: `${decision.reason}${note}; the gate-2-visual registration of seat ${effective.seat} passed on the D2 guard` };
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
  decidedBase: () => string | undefined = () => undefined,
  visualDemotion: () => VisualDemotion | null = () => null,
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
    const decision = onDecidedBase(shepherdGatePolicy(effective(), current, visualDemotion()).decide(action, target), target?.headSha, decidedBase(), current);
    if (decision.outcome === "deny") return decision;
    const escalated = target?.headSha === undefined ? undefined : escalationAt(target.headSha);
    if (escalated !== undefined && target?.headSha !== undefined && clearedByFreshMerge(escalated, decision, target.headSha, current)) return clearedDecision(escalated, decision, target.headSha);
    // Any other carried escalation gates even a head the policy would allow: only a fresh review at the head answers it.
    if (escalated !== undefined && (decision.outcome === "gate" || escalated.carriedFrom !== undefined)) return { outcome: "gate", rule: routeRule(escalated.escalation), reason: escalatedReason(escalated, target?.headSha, current) };
    if (decision.outcome !== "gate") return decision;
    return { ...decision, reason: escalationReason("policy-denial", decision.reason) };
  };
  const allowEvidence = (merge: { headSha: string }) => ({ ...mergeEvidenceAt(merge.headSha, current)?.record });
  return { policy: { decide }, allowEvidence, unsettled: { transient: isUnsettledGate, refresh }, featureBase: () => effective().featureBase === true, evidenceBase: (headSha) => mergeEvidenceAt(headSha, current)?.record.baseRef, skillPathsAt: (headSha) => skillPathsAt(headSha, current) };
}

/**
 * An allow judged on evidence read on another base than the one being decided gates: a retarget and back during the
 * re-read could otherwise merge on the other base's review rules and merge tree. Evidence with no base, or a decision
 * with no checked base, is left as it is.
 */
function onDecidedBase(decision: GateDecision, headSha: string | undefined, base: string | undefined, verdictFor: (headSha: string) => Verdict | undefined): GateDecision {
  const evidenceBase = headSha === undefined ? undefined : mergeEvidenceAt(headSha, verdictFor)?.record.baseRef;
  if (decision.outcome !== "allow" || base === undefined || evidenceBase === undefined || evidenceBase === base) return decision;
  return { outcome: "gate", rule: { table: "shepherd-merge-guard", rowId: "no-facts", version: 1 }, reason: `the merge facts at ${headSha} were read on base ${evidenceBase}, not on ${base}, the base being decided` };
}

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

/** The evidence a MERGE review carries; a malformed one reads as none, so the merge gates. */
export function mergeEvidenceAt(headSha: string, verdictFor: (headSha: string) => Verdict | undefined): MergeEvidence | undefined {
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
  if (!wellFormed) return undefined;
  const stored = evidence as MergeEvidence;
  // Only an absent line parses to undefined, so the stored evidence is returned as it is in that case.
  const ciPolicy = CiPolicySchema.parse(stored.ciPolicy);
  return ciPolicy ? { ...stored, ciPolicy } : stored;
}

function reviewNote(headSha: string | undefined, verdictFor: (headSha: string) => Verdict | undefined): string {
  const verdict = headSha === undefined ? undefined : verdictFor(headSha);
  return verdict ? `; review at this head: ${verdict.kind}` : "";
}

/** Read from the MERGE evidence at that head; a head with no well-formed evidence names none. */
function skillPathsAt(headSha: string, verdictFor: (headSha: string) => Verdict | undefined): string[] {
  return skillPathsIn(mergeEvidenceAt(headSha, verdictFor)?.merge.changedPaths ?? []);
}

function skillNote(headSha: string | undefined, verdictFor: (headSha: string) => Verdict | undefined): string {
  const skills = headSha === undefined ? [] : skillPathsAt(headSha, verdictFor);
  return skills.length > 0 ? `; repo skill changes: ${shownPaths(skills)}` : "";
}

function reasonNote(effective: EffectivePolicy): string {
  return effective.merge === "owner-gate" && effective.ownerGateReason ? ` (${effective.ownerGateReason})` : "";
}
