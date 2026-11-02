import { proofStanding } from "@titan-design/fix-proof";
import type { PullRequest } from "@titan-design/github";
import { DEFAULT_SHAPE_ROLES, type PanelPolicy, type ReviewTarget } from "@titan-design/review-panel";
import { DEFAULT_RETRY_POLICY, classifyFailure, preflight, type FailureClass, type PreflightDecision, type PreflightSnapshot, type RetryPolicy, type RetryRule, type ReviewPlanPolicy } from "@titan-design/review-workflow";
import type { StepRoute, WorkflowContext } from "@titan-design/workflow";
import { z } from "zod";
import { codeRoute, step } from "../workflows/land.js";
import { FixProofReadSchema } from "./fix-proof.js";
import type { Verdict } from "./phases.js";
import { classRulesFor, panelPolicyFor } from "./review-panel-plan.js";
import type { ReviewerRoles } from "./reviewer-roles.js";

// superseded-at:M5 (TP-3916 W1): the pool runner calls reviewHead itself, so nothing shadows Shepherd's review.

/** Recorded after each review round under `review.workflow: shadow`; computed from the round's records, so it dispatches nothing. */
export const REVIEW_SHADOW_STEP = "sh-review-shadow";

type ReviewWorkflowMode = "off" | "shadow" | "on" | "on:preflight";

/** `shadow` (S10) and `on:preflight` (S11) are built; `on` runs as `off`, with the reason logged, until S12 ships it. */
export function workflowModeOf(mode: ReviewWorkflowMode | undefined, warn: (text: string) => void = console.warn): { workflow?: "shadow" | "on:preflight" } {
  if (mode === "shadow" || mode === "on:preflight") return { workflow: mode };
  if (mode === "on") warn(`shepherd: review.workflow "${mode}" is not built yet (TP-3929), so it runs as off`);
  return {};
}

/** The intent records the mode, so a run recorded before the flag, or under `off`, replays with no shadow step. */
export const shadowOn = (intent: Readonly<Record<string, unknown>>): boolean => intent.workflow === "shadow";

const ShadowInputSchema = z.object({
  repo: z.string(),
  pr: z.number().int().positive(),
  head: z.string(),
  round: z.number().int().positive(),
  proof: FixProofReadSchema,
  /** The intent's recorded class; absent (no panel mode recorded it) classifies as g10, as an unread size does. */
  reviewClass: z.enum(["g10", "standard"]).optional(),
  dispatched: z.looseObject({ kind: z.string(), refused: z.string().optional(), reason: z.string().optional(), profile: z.string().optional() }),
  verdict: z.looseObject({ kind: z.enum(["MERGE", "FIX_FIRST", "NO_REPRO", "none"]), cause: z.string().optional() }),
});
type ShadowInput = z.infer<typeof ShadowInputSchema>;

interface ReviewShadow {
  kind: "shadow";
  round: number;
  /** The workflow's preflight decision: `go`, `stop:<outcome>`, `fixer:<class>` or `heal:<kind>+<kind>`. */
  decision: string;
  classes: FailureClass[];
  /** The policy action the workflow would take after this round, such as `fixer(start-refused:profile)` or `stop(NO_REPRO)`. */
  would: string;
}

export const ReviewShadowRead = z.looseObject({ kind: z.literal("shadow"), round: z.number(), decision: z.string(), classes: z.array(z.string()), would: z.string() });

/** The wiring the shadow plans with: the same panel table and role profiles the panel would be planned with. */
interface ShadowWiring {
  roles?: ReviewerRoles;
  panelPolicy?: PanelPolicy;
  profileInstalled?: (profile: string) => boolean;
}

/** Shepherd reviews only an open head at green CI that no carry signed off, so those parts of the snapshot are what it already held. */
function reviewedPr({ pr, head }: ShadowInput): PullRequest {
  const unmerged = { merged: false, mergeSha: null, mergedAt: null, autoMerge: false };
  return { number: pr, state: "open", ...unmerged, headRef: "", headSha: head, headRepo: null, baseRef: "", draft: false, mergeableState: "unknown", behind: false };
}

/** Every profile the policy could plan; with no installed check wired, each reads as installed, as the dispatch would find it. */
function profilesOf(policy: PanelPolicy, installed: (profile: string) => boolean): Record<string, boolean> {
  const shapes = Object.values({ ...DEFAULT_SHAPE_ROLES, ...policy.shapeRoles }).flatMap((roles) => [roles.g10, roles.standard]);
  const names = [policy.roles.g10, policy.roles.standard, ...shapes, ...Object.values(policy.sonnetFor ?? {})];
  return Object.fromEntries(names.map((name) => [name, installed(name)]));
}

function shadowSnapshot(input: ShadowInput, policy: PanelPolicy, installed: (profile: string) => boolean): PreflightSnapshot {
  const target: ReviewTarget = { repo: input.repo, pr: input.pr, head: input.head };
  const facts = { ...target, base: "", changedFiles: [] };
  const head = { pr: reviewedPr(input), ci: "green" as const, facts, sizeUnread: input.reviewClass !== "standard" };
  const passing = { carry: { kind: "no-carry" }, checkout: { kind: "ready" }, headroom: { opus: true, account: "available" } } as const;
  return { target, head, proof: proofStanding(input.proof, input.head), ...passing, profiles: profilesOf(policy, installed) };
}

function decisionWord(decision: PreflightDecision): string {
  if (decision.kind === "stop") return `stop:${decision.outcome.kind}`;
  if (decision.kind === "fixer") return `fixer:${decision.fixerCase.failure}`;
  return decision.kind === "heal" ? `heal:${decision.heals.join("+")}` : "go";
}

/** A dispatch the broker refused names its class; one that started nobody never started. */
function dispatchClass({ dispatched }: ShadowInput): FailureClass | undefined {
  if (dispatched.kind === "dispatched") return undefined;
  const profile = dispatched.profile ?? "";
  const member = { name: "", profile, degraded: false };
  const { refused, reason } = dispatched;
  const record = refused === undefined ? { kind: "never-started" as const, ...member } : { kind: "refused" as const, ...member, error: refused, message: reason ?? "" };
  return classifyFailure(record)?.class;
}

/** A started round's verdict as the taxonomy reads it; a reviewer that answered with no verdict line after its correction is malformed. */
const VERDICT_CLASSES: Readonly<Record<string, FailureClass>> = { "not-started": "never-started", timeout: "timeout", throttled: "throttled", "account-exhausted": "usage-limit", "no-verdict": "malformed" };

function roundClasses(input: ShadowInput): FailureClass[] {
  const refused = dispatchClass(input);
  if (refused !== undefined) return [refused];
  if (input.verdict.kind === "NO_REPRO") return ["shortfall"];
  const found = input.verdict.kind === "none" && input.verdict.cause !== undefined ? VERDICT_CLASSES[input.verdict.cause] : undefined;
  return found === undefined ? [] : [found];
}

/** Each Shepherd round spends one step of the class's row; an uncounted step repeats, and past the row comes its terminal. */
function rowAction(rule: RetryRule, round: number): string {
  let spent = 0;
  for (const rowStep of rule.steps) {
    const label = `${rowStep.action === "heal" ? rowStep.heal : rowStep.action}(${rule.class})`;
    if (rowStep.times === null) return label;
    spent += rowStep.times;
    if (round <= spent) return label;
  }
  if (rule.then.kind === "fixer") return `fixer(${rule.class})`;
  return rule.then.kind === "stop" ? `stop(${rule.then.outcome})` : "none";
}

const severity = (action: string): number => (action.startsWith("fixer(") ? 2 : action.startsWith("stop(") ? 1 : 0);

function wouldOf(decision: PreflightDecision, classes: readonly FailureClass[], input: ShadowInput, retry: RetryPolicy): string {
  if (decision.kind === "stop") return `stop(${decision.outcome.kind})`;
  if (decision.kind === "fixer") return `fixer(${decision.fixerCase.failure})`;
  if (decision.kind === "heal") return `heal(${decision.heals.join("+")})`;
  const actions = classes.flatMap((cls) => retry.filter((rule) => rule.class === cls).map((rule) => rowAction(rule, input.round)));
  const worst = actions.sort((a, b) => severity(b) - severity(a))[0];
  if (worst !== undefined) return worst;
  return input.verdict.kind === "MERGE" ? "merge" : input.verdict.kind === "FIX_FIRST" ? "fix-first" : "none";
}

/** What the workflow would have decided at this round, from the round's records alone. Pure but for the local installed-profile read. */
export function reviewShadow(raw: unknown, wiring: ShadowWiring = {}, retry: RetryPolicy = DEFAULT_RETRY_POLICY): ReviewShadow {
  const input = ShadowInputSchema.parse(raw);
  const installed = wiring.profileInstalled ?? (() => true);
  const panel: PanelPolicy = { ...(wiring.panelPolicy ?? panelPolicyFor(wiring.roles)), installed };
  const policy: ReviewPlanPolicy = { panel, rules: classRulesFor(wiring.roles) };
  const decision = preflight(shadowSnapshot(input, panel, installed), policy);
  const classes = roundClasses(input);
  return { kind: "shadow", round: input.round, decision: decisionWord(decision), classes, would: wouldOf(decision, classes, input, retry) };
}

export const reviewShadowRoute = (now: () => number, wiring?: ShadowWiring): StepRoute => codeRoute(REVIEW_SHADOW_STEP, now, async (raw: unknown) => reviewShadow(raw, wiring));

/** The round's records the shadow reads: the proof, the intent's class, the dispatch and the verdict. */
interface ShadowRound {
  target: ReviewTarget;
  proof: z.infer<typeof FixProofReadSchema>;
  intent: Readonly<Record<string, unknown>>;
  dispatched: Readonly<Record<string, unknown>>;
  verdict: Verdict;
}

const pick = (record: Readonly<Record<string, unknown>>, keys: readonly string[]): Record<string, unknown> =>
  Object.fromEntries(keys.flatMap((key) => (record[key] === undefined ? [] : [[key, record[key]]])));

/** Records the round's shadow at its head; the round count is how often this head's shadow was recorded before. */
export function recordShadow(ctx: WorkflowContext, { target, proof, intent, dispatched, verdict }: ShadowRound): Promise<z.infer<typeof ReviewShadowRead>> {
  const stepId = `${REVIEW_SHADOW_STEP}:${target.head}`;
  const reviewClass = intent.class === "g10" || intent.class === "standard" ? { reviewClass: intent.class } : {};
  const records = { dispatched: pick(dispatched, ["kind", "refused", "reason", "profile"]), verdict: pick(verdict, ["kind", "cause"]) };
  const input = { ...target, round: ctx.iteration(stepId) + 1, proof, ...reviewClass, ...records };
  return step(ctx, stepId, input, ReviewShadowRead);
}
