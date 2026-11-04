import type { MergeFacts } from "@titan-design/authority";
import { isObjectLike } from "@titan-design/rpc-protocol/narrow";
import type { GateDecision } from "../gate-policy.js";
import type { readRequiredChecks } from "../required-checks.js";
import { budgetMeasurement, ciPolicyClass } from "./ci-policy-class.js";
import { isGithubPath, type withCiPolicyRead } from "./ci-policy-read.js";
import { CI_POLICY_BUDGET_PREFIX, CI_POLICY_MALFORMED_REASON, CI_POLICY_WEAKENED_PREFIX, GITHUB_PATH_REASON_PREFIX } from "./evidence-comment.js";
import { guardRule, type DecidableEvidence, type MergeEvidenceInput } from "./merge-facts.js";
import type { PlanHonour } from "./plan-approval-cover.js";
import { shownPaths } from "./visual-gate.js";

/**
 * A reviewer who says CI policy is weakened, or writes the line in a shape the parser refuses, gates any PR for the owner.
 * A `.github/` change, rename sources included, with no line gates too, so a stored record from before the line existed
 * fails closed. A weakened line clears only under a plan approval pinning everything the PR merges; a malformed one never does.
 */
export function ciPolicyGate(evidence: DecidableEvidence, honour: PlanHonour, headSha: string): GateDecision | undefined {
  const { ciPolicy } = evidence;
  if (ciPolicy?.kind === "malformed") return { outcome: "gate", rule: guardRule("ci-policy-malformed"), reason: CI_POLICY_MALFORMED_REASON };
  if (ciPolicy?.kind === "weakened") {
    if (honour.coversCiPolicy({ keys: ciPolicy.keys, changed: evidence.merge.changedPaths, headBlobs: evidence.record.headBlobs })) return undefined;
    const measurement = budgetAt(evidence, headSha);
    if (measurement !== undefined) return { outcome: "gate", rule: guardRule("ci-policy-budget"), reason: `${CI_POLICY_BUDGET_PREFIX}${shownPaths(ciPolicy.keys)}; measured at ${measurement}` };
    return { outcome: "gate", rule: guardRule("ci-policy-weakened"), reason: `${CI_POLICY_WEAKENED_PREFIX}${shownPaths(ciPolicy.keys)}${honour.unplanned("ci-policy")}` };
  }
  if (ciPolicy?.kind === "unchanged") return undefined;
  const github = evidence.merge.changedPaths.filter(isGithubPath);
  if (github.length === 0) return undefined;
  return { outcome: "gate", rule: guardRule("github-path"), reason: `${GITHUB_PATH_REASON_PREFIX}${shownPaths(github)}` };
}

/**
 * The measurement of a budget-class weakened line, read only when the reviewer's own MERGE is at this head and carried
 * nowhere; owner decision 552 (2) lets a coordinator resolve that gate, so any doubt reads as a weakening.
 */
export function budgetAt(evidence: Pick<DecidableEvidence, "head" | "merge" | "ciPolicy" | "ciPolicyClass">, headSha: string): string | undefined {
  const measurement = evidence.ciPolicy?.kind === "weakened" ? budgetMeasurement(evidence.ciPolicyClass) : undefined;
  // Stored evidence is not parsed on read (policy.ts), so its verdict may be missing.
  const verdict: unknown = evidence.merge.verdict;
  const fresh = evidence.head === headSha && isObjectLike(verdict) && verdict.value === "MERGE" && verdict.head === headSha && evidence.merge.carry === undefined;
  return fresh ? measurement : undefined;
}

/** What could not be read, beside the CI-policy facts, which read as weakening when anything could not. */
export function unknownAndCiPolicy(input: MergeEvidenceInput, read: CiPolicyRead, required: Awaited<ReturnType<typeof readRequiredChecks>>, filesUnread: string | undefined) {
  const unknown = { ...(!required.readable && { requiredChecksUnknown: required.reason }), ...(filesUnread !== undefined && { changedFilesUnread: filesUnread }) };
  return { ...unknown, ...ciPolicyFacts(input, read, filesUnread !== undefined || !required.readable) };
}

interface CiPolicyRead {
  prBody: string | undefined;
  merge: MergeFacts;
  read: Awaited<ReturnType<typeof withCiPolicyRead>>;
}

/** The CI-policy read less its whole files, which are never stored, and on a weakened line its class (ci-policy-class.ts). */
function ciPolicyFacts(input: MergeEvidenceInput, { prBody, merge, read: { ciPolicyFiles, ciPolicyUnread, ...read } }: CiPolicyRead, otherUnread: boolean) {
  if (input.ciPolicy?.kind !== "weakened") return read;
  const sides = { files: ciPolicyFiles ?? [], unread: ciPolicyUnread === true || otherUnread, required: merge.requiredContexts, changedPaths: merge.changedPaths };
  const freshMerge = merge.verdict.head === merge.head && merge.carry === undefined;
  return { ...read, ciPolicyClass: ciPolicyClass({ ...sides, keys: input.ciPolicy.keys, repo: input.repo, prBody, freshMerge }) };
}
