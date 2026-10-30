import { endsReview, type ProofStanding } from "@titan-design/fix-proof";
import { UninstalledProfileError, type ReviewTarget } from "@titan-design/review-panel";
import type { FixerCase } from "./fixer.js";
import type { HealRequest } from "./heal.js";
import { planForHead, type HeadPlan, type HoldMember, type ReviewPlanPolicy } from "./plan-for-head.js";
import type { CarryProbe, CheckoutState, HeadroomRead, HeadSnapshot } from "./ports.js";
import type { HealKind } from "./retry-policy.js";
import type { ReviewOutcome } from "./types.js";

/** Everything preflight decides on, read in one pass by `preflightRead`; recorded, so a replay decides the same way. */
export interface PreflightSnapshot {
  target: ReviewTarget;
  head: HeadSnapshot;
  proof: ProofStanding;
  /** The base the proof judged (TP-4259), kept for a later merge guard; absent when the read names none. */
  proofBase?: string;
  carry: CarryProbe;
  checkout: CheckoutState;
  headroom: HeadroomRead;
  /** Each profile the policy could plan and whether it is installed; a profile left out reads as not installed. */
  profiles: Readonly<Record<string, boolean>>;
  hold?: HoldMember;
}

/** `heal` is the shape `healOnce` consumes; `go` carries the plan the members are dispatched from. */
export type PreflightDecision =
  | { kind: "go"; plan: HeadPlan }
  | HealRequest
  | { kind: "stop"; outcome: ReviewOutcome }
  | { kind: "fixer"; fixerCase: FixerCase };

function prStop({ target, head: { pr, ci } }: PreflightSnapshot): ReviewOutcome | undefined {
  const head = target.head;
  if (pr.merged) return { kind: "not-open", head, state: "merged" };
  if (pr.state === "closed") return { kind: "not-open", head, state: "closed" };
  if (pr.draft) return { kind: "not-open", head, state: "draft" };
  if (pr.headSha !== head) return { kind: "head-moved", head, current: pr.headSha };
  return ci === "green" ? undefined : { kind: "ci-not-green", head, ci };
}

/** Only CI's own failed proof of a workflow-only diff may be waived; a proceeding NO_REPRO never ends the review. */
function proofStop({ target, proof }: PreflightSnapshot): ReviewOutcome | undefined {
  if (proof.kind !== "no-repro" || !endsReview(proof)) return undefined;
  return { kind: "NO_REPRO", head: target.head, waivable: "kind" in proof.result && proof.result.kind === "workflow-ci" };
}

/** A carried merge-up needs no reviewer; otherwise catching up to main is the author's lane, never the workflow's. */
function branchStop({ target, carry, head: { pr } }: PreflightSnapshot): ReviewOutcome | undefined {
  const head = target.head;
  if (carry.kind === "carries") return { kind: "carried", head, from: carry.from };
  if (pr.mergeableState === "dirty") return { kind: "conflict", head };
  return pr.mergeableState === "behind" ? { kind: "needs-update", head } : undefined;
}

const profileFixer = (profile: string): PreflightDecision => ({ kind: "fixer", fixerCase: { failure: "start-refused:profile", key: "profile", detail: [profile] } });

/** A member whose profile is not installed could only be refused at dispatch, so it goes to the fixer before any starts. */
function plannedOrRefused(snapshot: PreflightSnapshot, policy: ReviewPlanPolicy): PreflightDecision {
  let planned: HeadPlan;
  try {
    planned = planForHead(snapshot.head, policy, snapshot.proof, snapshot.hold, snapshot.headroom);
  } catch (error) {
    if (error instanceof UninstalledProfileError) return profileFixer(error.profile);
    throw error;
  }
  const installed = (profile: string): boolean => snapshot.profiles[profile] === true;
  const refused = planned.plan.members.find((member) => !installed(member.profile));
  return refused === undefined ? { kind: "go", plan: planned } : profileFixer(refused.profile);
}

function healsFor({ checkout, headroom }: PreflightSnapshot): HealKind[] {
  const heals: HealKind[] = [];
  if (checkout.kind !== "ready") heals.push("refresh-checkout");
  if (headroom.account === "held") heals.push("await-account");
  return heals;
}

/**
 * The gate before any reviewer starts. Order: not open, head moved, CI not green, a NO_REPRO that ends the review, a carried
 * merge-up, behind or dirty, then the plan and its profiles, then the heals the checkout and account need. Pure.
 */
export function preflight(snapshot: PreflightSnapshot, policy: ReviewPlanPolicy): PreflightDecision {
  const outcome = prStop(snapshot) ?? proofStop(snapshot) ?? branchStop(snapshot);
  if (outcome !== undefined) return { kind: "stop", outcome };
  const planned = plannedOrRefused(snapshot, policy);
  if (planned.kind !== "go") return planned;
  const heals = healsFor(snapshot);
  return heals.length > 0 ? { kind: "heal", heals } : planned;
}
