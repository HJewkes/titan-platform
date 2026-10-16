import type { PrFile } from "@titan-design/github";
import { classifyPr, DEFAULT_CLASS_RULES, DEFAULT_PANEL_TABLE, planPanel } from "@titan-design/review-panel";
import type { ChangedFile, ClassRules, Headroom, PanelPlan, PanelPolicy, PrClass, PrFacts, ReviewClass, ReviewTarget, ShapeRule } from "@titan-design/review-panel";
import { prFilesOf, registeredBase } from "./git-pr-files.js";
import { registeredKind } from "./merge-facts.js";
import type { ShepherdDeps } from "./phases.js";
import { DEFAULT_REVIEWER_ROLES, prChangedLines, type ReviewerRoles } from "./reviewer-roles.js";

/** `shadow` records the plan on the intent and spawns nothing more; `on` reviews with the panel. */
export type PanelMode = "off" | "shadow" | "on";

/** Opus is always allowed until TP-1931 asks the spawn gate. */
const OPEN_HEADROOM: Headroom = { opus: true };

type PanelDeps = Pick<ShepherdDeps, "store" | "port" | "prFiles">;

/** The PR as classification sees it; `sizeUnread` means the file list or a line count could not be read. */
export interface PanelFacts {
  facts: PrFacts;
  sizeUnread: boolean;
}

/** What `sh-review-intent` records under a panel mode other than `off`. */
export interface IntentPlan {
  class: ReviewClass;
  touches: PrClass["touches"];
  plan: PanelPlan;
}

/** TP-1428's role table keeps choosing the correctness member; the other shapes follow the package's class table. */
export function panelPolicyFor(roles: ReviewerRoles = DEFAULT_REVIEWER_ROLES): PanelPolicy {
  return { roles: { g10: roles.g10, standard: roles.standard }, panel: DEFAULT_PANEL_TABLE };
}

/** The configured g10 line limit is the panel's large-PR limit, so the single reviewer and the panel class one diff alike. */
export function classRulesFor(roles: ReviewerRoles | undefined): ClassRules {
  return roles?.g10ChangedLines === undefined ? DEFAULT_CLASS_RULES : { ...DEFAULT_CLASS_RULES, largeLines: roles.g10ChangedLines };
}

const changedFileOf = ({ path, previousPath, additions, deletions }: PrFile): ChangedFile => ({ path, ...(previousPath !== undefined && { previousPath }), additions: additions ?? Number.NaN, deletions: deletions ?? Number.NaN });

/** A list that cannot be read, or one `prChangedLines` cannot size, is an unread size. A known base reads the head's diff from git. */
async function readFiles(deps: PanelDeps, { repo, pr, head }: ReviewTarget, base: string | undefined, rules: ClassRules): Promise<{ files: ChangedFile[]; sizeUnread: boolean }> {
  try {
    const files = await prFilesOf(deps.port, { repo, pr, head, ...(base !== undefined && { base }) }, deps.prFiles);
    return { files: files.map(changedFileOf), sizeUnread: prChangedLines(files, rules.largeLines) === undefined };
  } catch {
    return { files: [], sizeUnread: true };
  }
}

/**
 * The PR's facts from its registered kind and its file list; an unreadable store leaves the kind out, which classifies as g10.
 * `base` is empty because classification never reads it and the intent step reads no base.
 */
export async function panelFacts(deps: PanelDeps, { repo, pr, head }: ReviewTarget, runId: string, rules: ClassRules = DEFAULT_CLASS_RULES): Promise<PanelFacts> {
  const read = registeredKind(deps.store, runId);
  const kind = read.unread === undefined ? read.kind : undefined;
  const { files, sizeUnread } = await readFiles(deps, { repo, pr, head }, registeredBase(deps.store, runId), rules);
  return { facts: { repo, pr, head, base: "", ...(kind !== undefined && { kind }), changedFiles: files }, sizeUnread };
}

/** An unread size is read as large, as the single reviewer's `sizeUnread` takes the g10 profile. */
function stricter(found: PrClass): PrClass {
  return { class: "g10", touches: found.touches.includes("large") ? found.touches : [...found.touches, "large"] };
}

/** The profile of the adversary member a g10-adversary hold adds, whatever the panel table says; absent adds none. */
export interface HoldMember {
  profile: string;
}

export const DEFAULT_ADVERSARY_PROFILE = "fable-reviewer";

const HOLD_RULE: ShapeRule = { shape: "adversary", classes: ["g10", "standard"], touches: [], blocking: true, always: true };

/**
 * The hold's adversary member goes first among the shapes beside correctness, so the member cap never drops it, and at the hold's
 * profile, so it never shares the correctness member's. Under a panel other than `on` it is the only member beside correctness.
 */
function withHoldMember(policy: PanelPolicy, member: HoldMember, fullPanel: boolean): PanelPolicy {
  const rest = fullPanel ? (policy.panel ?? []).filter((rule) => rule.shape !== "adversary") : [];
  return { ...policy, panel: [HOLD_RULE, ...rest], shapeRoles: { ...policy.shapeRoles, adversary: { g10: member.profile, standard: member.profile } } };
}

/** How the head is planned beyond its files: a held head's adversary member, and whether the rest of the panel table applies. */
interface PlanOptions {
  holdMember?: HoldMember;
  fullPanel?: boolean;
}

/** The class, touches and panel plan for one head. Pure. */
export function intentPlan({ facts, sizeUnread }: PanelFacts, policy: PanelPolicy, headroom: Headroom = OPEN_HEADROOM, rules: ClassRules = DEFAULT_CLASS_RULES, options: PlanOptions = {}): IntentPlan {
  const found = classifyPr(facts, rules);
  const cls = sizeUnread ? stricter(found) : found;
  const planned = options.holdMember ? withHoldMember(policy, options.holdMember, options.fullPanel ?? true) : policy;
  return { class: cls.class, touches: cls.touches, plan: planPanel(cls, planned, headroom) };
}

const PLAN_KEYS: ReadonlySet<string> = new Set(["class", "touches", "plan", "panel", "panelReviewers"]);

/** The intent `sh-review` takes: the plan stays on the intent's record, so a shadow dispatch gets the input an `off` one does. */
export function withoutPlan(intent: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(intent).filter(([key]) => !PLAN_KEYS.has(key)));
}
