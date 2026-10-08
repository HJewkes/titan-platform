import { DEFAULT_TABLE, evaluate, type MergeFacts } from "@titan-design/authority";
import { GITHUB_ACTIONS_APP_ID } from "@titan-design/github";
import { escalationReason } from "../shepherd/route-table.js";
import { MERGE_ON_GREEN_GRANT } from "../shepherd/seats.js";

const REVIEWER = { agentId: "rv-synthetic", sessionId: "rv-session" };

/** Merge facts under which MRG-AU-RV allows: every condition holds at `head`. */
function allowingFacts(head: string): MergeFacts {
  return {
    ...{ head, resolver: REVIEWER, dispatchedReviewer: REVIEWER, verdict: { value: "MERGE", head }, requiredContexts: ["validate"], allowedApps: [GITHUB_ACTIONS_APP_ID] },
    ...{ checkRuns: [{ name: "validate", appId: GITHUB_ACTIONS_APP_ID, headSha: head, conclusion: "success" }], mergeTreeClean: true, repoFrozen: false },
    ...{ changedPaths: ["src/feature.ts"], seatGrants: [MERGE_ON_GREEN_GRANT], kind: "feature" },
  };
}

/** The required check still running at `head`: the mechanical reason MRG-AU gated. */
export const pendingCheck = (head: string): Partial<MergeFacts> => ({ checkRuns: [{ name: "validate", appId: GITHUB_ACTIONS_APP_ID, headSha: head, conclusion: null }] });

/**
 * The reason Shepherd records for an authority gate, from the real authority table over these facts, wrapped as
 * `shepherdLandOptions` wraps a policy gate. Throws when the facts would not gate, so a fixture cannot drift into an allow.
 */
export function authorityGateReason(head: string, overrides: Partial<MergeFacts>, tainted = false): string {
  const facts = { ...allowingFacts(head), ...overrides };
  const decision = evaluate(DEFAULT_TABLE, { action: "merge", actor: { class: "automation", id: "titan-factory" }, tainted, subject: { repo: "o/r", pr: "1" }, facts: { merge: facts } });
  if (decision.verdict !== "gate") throw new Error(`fixture facts did not gate: ${JSON.stringify(decision)}`);
  return escalationReason("policy-denial", decision.reason);
}
