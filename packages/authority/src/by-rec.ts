import { isCarryFencedPath, isNonCanonical } from "./paths.js";
import { isFullSha, isRecord, isStringList } from "./shape.js";
import type { ByRecConditionKind } from "./vocabulary.js";

/** The approve-merge gate as the caller read it. Times are epoch milliseconds, read by the caller, since the evaluator has no clock. */
export interface OwnerGateFact {
  /** The head the gate was opened at. */
  head: string;
  /** True while no one has answered the gate. */
  pending: boolean;
  /** The option id the gate marks recommended, or null when it marks none. */
  recommended: string | null;
  openedAt: number;
  observedAt: number;
}

/** The facts MRG-AU-RB's own conditions read; `MergeFacts` carries each of them. */
export interface ByRecFacts {
  head: string;
  changedPaths: string[];
  ownerGate?: OwnerGateFact;
  holdClasses?: string[];
  headRef?: string;
}

const SILENT_MS = 24 * 60 * 60 * 1000;
const G10_PREFIX = "g10";
const RELEASE_BRANCH = /^(?:[^:]+:)?(?:changeset-release|release)\//i;
const RELEASE_FILES = new Set([".changeset/config.json", ".changeset/pre.json"]);
const RELEASE_WORKFLOW_PREFIX = ".github/workflows/release";
const CHANGELOG = "changelog.md";

function ownerGateAt(facts: ByRecFacts): OwnerGateFact | undefined {
  const gate = facts.ownerGate;
  if (!isRecord(gate) || !isFullSha(facts.head) || gate.head !== facts.head || gate.pending !== true) return undefined;
  return gate;
}

function ownerGateSilent24h(facts: ByRecFacts): boolean {
  const gate = ownerGateAt(facts);
  if (!gate || !Number.isSafeInteger(gate.openedAt) || !Number.isSafeInteger(gate.observedAt) || gate.openedAt <= 0) return false;
  return gate.observedAt - gate.openedAt >= SILENT_MS;
}

function gateRecommendsMerge(facts: ByRecFacts): boolean {
  return ownerGateAt(facts)?.recommended === "merge";
}

function changedPathsOf(facts: ByRecFacts): string[] | undefined {
  const paths = facts.changedPaths;
  return isStringList(paths) && paths.length > 0 ? paths : undefined;
}

// A `.claude` entry, or anything under `.claude/skills`, is a skill change that gates for the owner at its head.
function isSkillPath(path: string): boolean {
  const segments = path.toLowerCase().split("/");
  return segments.some((segment, index) => segment === ".claude" && (index === segments.length - 1 || segments[index + 1] === "skills"));
}

function isHeldClass(holdClass: string): boolean {
  return holdClass.trim().toLowerCase().startsWith(G10_PREFIX);
}

// Authority, tool-guard, CI-policy and skill paths always earn a g10 or owner-at-head hold, so they count as held even when the caller's hold read missed one.
function noG10Hold(facts: ByRecFacts): boolean {
  const paths = changedPathsOf(facts);
  const { holdClasses } = facts;
  if (!paths || !isStringList(holdClasses) || holdClasses.some(isHeldClass)) return false;
  return !paths.some((path) => isCarryFencedPath(path) || isSkillPath(path));
}

function isReleasePath(path: string): boolean {
  if (isNonCanonical(path)) return true;
  const folded = path.toLowerCase();
  return RELEASE_FILES.has(folded) || folded.startsWith(RELEASE_WORKFLOW_PREFIX) || folded.split("/").at(-1) === CHANGELOG;
}

function noReleasePath(facts: ByRecFacts): boolean {
  const paths = changedPathsOf(facts);
  const { headRef } = facts;
  if (!paths || typeof headRef !== "string" || headRef.length === 0 || isNonCanonical(headRef) || RELEASE_BRANCH.test(headRef)) return false;
  return !paths.some(isReleasePath);
}

/** MRG-AU-RB's own conditions; the row shares every other condition with MRG-AU-RV. */
export const BY_REC_CHECKS: Record<ByRecConditionKind, (facts: ByRecFacts) => boolean> = {
  "owner-gate-silent-24h": ownerGateSilent24h,
  "gate-recommends-merge": gateRecommendsMerge,
  "no-g10-hold": noG10Hold,
  "no-release-path": noReleasePath,
};
