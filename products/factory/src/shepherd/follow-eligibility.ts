import { isCarryFencedPath } from "@titan-design/authority";
import { CARRYING_KINDS } from "./carry-kinds.js";
import { isSkillPath } from "./skill-paths.js";

/**
 * Which owner answers may follow a head to a later land gate. The workflow's approval carry (approval-carry.ts) and the
 * coordinator's merge-up approval (merge-up-approval.ts) both decide through these fences, so a fence added here holds on
 * both paths at once.
 */

/** An escalation (failed rounds, a runaway fixer, a conflict) is a decision about the run, so it never follows a head. */
export const ESCALATION_TABLE = "shepherd-route";

/**
 * Kinds whose owner approve-merge answer may follow only a clean merge-up whose base side touches none of the PR's files
 * (G10): the remerge and fix-probe rules stay closed to them.
 * Why: the 2026-10-11 owner decision (TP-2252) lets an owner's approval carry across Shepherd's own merge-up for security PRs.
 */
const OWN_MERGE_UP_KINDS: ReadonlySet<string> = new Set(["security"]);

/** `carrying` may follow the remerge, fix-probe and merge-up rules; `own-merge-up` only a disjoint clean merge-up. */
export type FollowRule = "carrying" | "own-merge-up";

/** The rule a registered kind follows by; every other kind, and no registration, follows nothing. */
export function followRuleOf(kind: string | null | undefined): FollowRule | undefined {
  if (kind === null || kind === undefined) return undefined;
  if (CARRYING_KINDS.has(kind)) return "carrying";
  return OWN_MERGE_UP_KINDS.has(kind) ? "own-merge-up" : undefined;
}

/** A land gate's policy rule (`table/row`) and the first D21 owner-at-head row it holds, if any. */
export interface FollowGate {
  rule: string;
  ownerAtHead: string | undefined;
}

/**
 * Whether an owner answer may follow a head onto, or away from, this gate: never an escalation, and never a gate holding a
 * D21 row, which the owner reads at their own head.
 */
export const gateFollowable = (gate: FollowGate): boolean => gate.ownerAtHead === undefined && !gate.rule.startsWith(`${ESCALATION_TABLE}/`);

/** The paths a carry vouches the owner already saw: none at all, or any repo skill, would put an unseen diff under the answer. */
export const vouchedFollowable = (paths: readonly string[] | undefined): boolean => paths !== undefined && !paths.some(isSkillPath);

/**
 * What a merge-up's base side brought in may sit under a followed answer: no carry-fenced path and no repo skill, and under
 * `own-merge-up` none of the PR's own paths either. A rename lists both sides, so either side meets the fences.
 */
export function baseSideFollowable(rule: FollowRule, mainPaths: readonly string[], prPaths: readonly string[]): boolean {
  if (mainPaths.some((path) => isCarryFencedPath(path) || isSkillPath(path))) return false;
  if (rule === "carrying") return true;
  const main = new Set(mainPaths.map((path) => path.toLowerCase()));
  return !prPaths.some((path) => main.has(path.toLowerCase()));
}

/** Every fact a follow across clean merge-ups rests on. */
export interface MergeUpFollow {
  kind: string | null | undefined;
  /** The gate the answer would follow onto, and the gate the owner gave it on. */
  target: FollowGate;
  source: FollowGate;
  /** A reviewer refused this exact head; re-running CI never overrides that. */
  fixFirstAtHead: boolean;
  /** What the merge-ups brought from the base, and what the PR itself changed since it left the base. */
  mainPaths: readonly string[];
  prPaths: readonly string[];
}

/** Why an owner's answer may not follow clean merge-ups to a later gate under the fences above; undefined when it may. */
export function mergeUpFollowRefusal(facts: MergeUpFollow): string | undefined {
  const rule = followRuleOf(facts.kind);
  if (rule === undefined) return `a run of kind ${facts.kind ?? "unregistered"} carries no owner answer`;
  if (!gateFollowable(facts.target)) return `the gate is ${facts.target.ownerAtHead ?? facts.target.rule}, which the owner answers at its own head`;
  if (!gateFollowable(facts.source)) return `the owner answered on ${facts.source.ownerAtHead ?? facts.source.rule}, an answer that follows no head`;
  if (facts.fixFirstAtHead) return "a reviewer's FIX_FIRST stands at the gated head";
  if (!vouchedFollowable(facts.prPaths)) return "the PR changes a repo skill";
  return baseSideFollowable(rule, facts.mainPaths, facts.prPaths) ? undefined : `the merge-ups bring a fenced path${rule === "own-merge-up" ? " or one of the PR's own files" : ""}`;
}

export const mergeUpFollows = (facts: MergeUpFollow): boolean => mergeUpFollowRefusal(facts) === undefined;
