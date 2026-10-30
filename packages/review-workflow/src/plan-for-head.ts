import { needsTestsSeat, type ProofStanding } from "@titan-design/fix-proof";
import { classifyPr, DEFAULT_CLASS_RULES, planPanel } from "@titan-design/review-panel";
import type { ClassRules, Headroom, PanelPlan, PanelPolicy, PrClass, PrFacts, ReviewClass, ShapeRule } from "@titan-design/review-panel";

/** The PR as classification sees it; `sizeUnread` means the file list or a line count could not be read. */
export interface PlanFacts {
  facts: PrFacts;
  sizeUnread?: boolean;
}

/** The panel table and role profiles, plus the class rules that size a diff; absent rules are review-panel's defaults. */
export interface ReviewPlanPolicy {
  panel: PanelPolicy;
  rules?: ClassRules;
}

/** The profile of the adversary member a hold adds, whatever the panel table says; a `PanelMember` fits. */
export interface HoldMember {
  profile: string;
}

export interface HeadPlan {
  class: ReviewClass;
  touches: PrClass["touches"];
  plan: PanelPlan;
}

/** Opus is open unless the caller's headroom read says otherwise. */
const OPEN_HEADROOM: Headroom = { opus: true };

/** An unread size is read as large, as the single reviewer's `sizeUnread` takes the g10 profile. */
function stricter(found: PrClass): PrClass {
  return { class: "g10", touches: found.touches.includes("large") ? found.touches : [...found.touches, "large"] };
}

const HOLD_RULE: ShapeRule = { shape: "adversary", classes: ["g10", "standard"], touches: [], blocking: true, always: true, uncapped: true };

/**
 * The hold's adversary goes first among the shapes beside correctness, so the member cap never drops it, and at the hold's
 * profile, uncapped, so an opus or fable correctness member keeps the premium seat beside it (TP-3907).
 */
function withHoldMember(policy: PanelPolicy, member: HoldMember): PanelPolicy {
  const rest = (policy.panel ?? []).filter((rule) => rule.shape !== "adversary");
  return { ...policy, panel: [HOLD_RULE, ...rest], shapeRoles: { ...policy.shapeRoles, adversary: { g10: member.profile, standard: member.profile } } };
}

const TESTS_RULE: ShapeRule = { shape: "tests", classes: ["g10", "standard"], touches: [], blocking: true, always: true };

/** A tests member answers a proof short of proved (TP-4195); it goes right after a hold's adversary so the member cap keeps it. */
function withTestsMember(policy: PanelPolicy, afterHold: boolean): PanelPolicy {
  const panel = policy.panel ?? [];
  const lead = afterHold ? panel.slice(0, 1) : [];
  const rest = panel.slice(lead.length).filter((rule) => rule.shape !== "tests");
  return { ...policy, panel: [...lead, TESTS_RULE, ...rest] };
}

/** The class, touches and panel for one head. The standing decides the tests seat, so it is never re-derived here. Pure. */
export function planForHead({ facts, sizeUnread }: PlanFacts, policy: ReviewPlanPolicy, standing: ProofStanding, hold?: HoldMember, headroom: Headroom = OPEN_HEADROOM): HeadPlan {
  const rules = policy.rules ?? DEFAULT_CLASS_RULES;
  const found = classifyPr(facts, rules);
  const cls = sizeUnread === true ? stricter(found) : found;
  const held = hold === undefined ? policy.panel : withHoldMember(policy.panel, hold);
  const planned = needsTestsSeat(standing) ? withTestsMember(held, hold !== undefined) : held;
  return { class: cls.class, touches: cls.touches, plan: planPanel(cls, planned, headroom) };
}
