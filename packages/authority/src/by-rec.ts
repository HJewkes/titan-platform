import { isCarryFencedPath, isNonCanonical, isOwnerFloorPath } from "./paths.js";
import type { AgentIdentity } from "./shape.js";
import { isFullSha, isRecord, isStringList, sameAgent } from "./shape.js";
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
  dispatchedReviewer: AgentIdentity;
  verdict: { author?: AgentIdentity };
  changedPaths: string[];
  ownerGate?: OwnerGateFact;
  holdClasses?: string[];
  ownerTierPaths?: string[];
  headRef?: string;
}

const SILENT_MS = 24 * 60 * 60 * 1000;
const RELEASE_BRANCH = /^(?:[^:]+:)?(?:refs\/heads\/)?(?:changeset-release|release)\//i;
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

// In MRG-AU-RB Shepherd resolves, not the reviewer, so the verdict's own author must be the dispatched reviewer.
function verdictByDispatchedReviewer(facts: ByRecFacts): boolean {
  const author = facts.verdict.author;
  return isRecord(author) && isRecord(facts.dispatchedReviewer) && sameAgent(author, facts.dispatchedReviewer);
}

function changedPathsOf(facts: ByRecFacts): string[] | undefined {
  const paths = facts.changedPaths;
  return isStringList(paths) && paths.length > 0 ? paths : undefined;
}

function noHold(facts: ByRecFacts): boolean {
  const { holdClasses } = facts;
  return isStringList(holdClasses) && holdClasses.length === 0;
}

// The caller's owner-tier read is the authority on which paths stay the owner's; the fixed floor still refuses when that read missed one.
function noOwnerPath(facts: ByRecFacts): boolean {
  const paths = changedPathsOf(facts);
  const { ownerTierPaths } = facts;
  if (!paths || !isStringList(ownerTierPaths) || ownerTierPaths.length > 0) return false;
  return !paths.some((path) => isCarryFencedPath(path) || isOwnerFloorPath(path));
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
  "verdict-by-dispatched-reviewer": verdictByDispatchedReviewer,
  "no-hold": noHold,
  "no-owner-path": noOwnerPath,
  "no-release-path": noReleasePath,
};
