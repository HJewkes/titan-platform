import { UninstalledProfileError, type ReviewTarget } from "@titan-design/review-panel";
import { fixerFingerprint } from "@titan-design/review-workflow";
import type { WorkflowContext } from "@titan-design/workflow";
import { noReviewerHeld } from "./no-reviewer-hold.js";
import type { Verdict } from "./phases.js";

// superseded-at:M5 (TP-3916 W2): the pool runner calls reviewHead, whose own preflight gates every dispatch.

/** `review.workflow` as the review wiring holds it; `on` runs as `off` until TP-3929. */
export type ReviewWorkflowWiring = "shadow" | "on:preflight";

/** A hard error preflight found before any reviewer started: the fixer fingerprint, recorded on the intent step. */
interface PreflightFixer {
  fingerprint: string;
  failure: "start-refused:profile";
}

interface PlannedMembers {
  panel?: "on";
  plan: { members: readonly { profile: string }[] };
}

export type PreflightPlan<P> = { kind: "planned"; planned: P } | { kind: "none"; reason: string; fixer: PreflightFixer };

export const preflightOn = (workflow: ReviewWorkflowWiring | undefined): boolean => workflow === "on:preflight";

function needsFixer(profile: string): PreflightPlan<never> {
  const fingerprint = fixerFingerprint({ failure: "start-refused:profile", key: "profile", detail: [profile] });
  return { kind: "none", reason: `preflight: the profile '${profile}' is not installed`, fixer: { fingerprint, failure: "start-refused:profile" } };
}

/**
 * The plan a panel would dispatch, refused when a member it starts is planned onto an uninstalled profile or lowered to one
 * (tp#1986). Only a panel that is `on` starts its members, so a shadow plan's members are never checked.
 */
export async function preflightPlan<P extends PlannedMembers | undefined>(plan: () => Promise<P>, installed: ((profile: string) => boolean) | undefined): Promise<PreflightPlan<P>> {
  let planned: P;
  try {
    planned = await plan();
  } catch (error) {
    if (error instanceof UninstalledProfileError) return needsFixer(error.profile);
    throw error;
  }
  const started = planned?.panel === "on" ? planned.plan.members : [];
  const refused = installed === undefined ? undefined : started.find((member) => !installed(member.profile));
  return refused === undefined ? { kind: "planned", planned } : needsFixer(refused.profile);
}

const recordedFingerprint = (result: Readonly<Record<string, unknown>>): string | undefined => {
  const fixer = result.fixer;
  if (typeof fixer !== "object" || fixer === null || !("fingerprint" in fixer)) return undefined;
  return typeof fixer.fingerprint === "string" ? fixer.fingerprint : undefined;
};

/** An intent preflight refused holds the run on its fingerprint, as a refused dispatch holds it, and ends `needs-fixer`. */
export function preflightRefused(ctx: WorkflowContext, target: ReviewTarget, result: Readonly<Record<string, unknown>>): Promise<Verdict> | undefined {
  const fingerprint = recordedFingerprint(result);
  if (fingerprint === undefined) return undefined;
  const reason = typeof result.reason === "string" ? result.reason : `preflight: ${fingerprint}`;
  return noReviewerHeld(ctx, target, reason, fingerprint);
}
