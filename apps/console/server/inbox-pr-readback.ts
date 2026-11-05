/**
 * The read-back of an inbox tap on a PR: what a gate decision or a release does at the PR's head, and for a merge on an
 * owner-at-head gate the evidence the owner confirms against (TP-4404).
 */
import type { G10Action } from "./g10-hold.js";
import { gateEvidenceOf, type GateEvidence } from "./inbox-gate-evidence.js";
import type { ConsoleDecision, InboxItem, InboxSources } from "./inbox-view.js";

export type PostedAction = Extract<InboxItem["action"], { kind: "resolve-gate" | "owner-release" }>;
type GateAction = Extract<PostedAction, { kind: "resolve-gate" }>;

export type PrReadBack = {
  repo: string;
  pr: number;
  title: string;
  headSha: string;
  gateId?: string;
  hold?: { class: string; reason: string };
  effect: string;
  evidence?: GateEvidence;
};

export const prBaseOf = (item: InboxItem, action: PostedAction | G10Action) => ({ repo: action.repo, pr: action.pr, title: item.summary, headSha: action.headSha, ...(item.hold && { hold: item.hold }) });

/** A merge on an owner-at-head gate reads back that gate's evidence (TP-4404), or offers no tap when the card cannot show it. */
export async function gateReadBack(sources: InboxSources, item: InboxItem, action: GateAction, at: string): Promise<PrReadBack | string> {
  const base = { ...prBaseOf(item, action), gateId: action.gateId, effect: gateEffect(action.decision, at) };
  const evidence = action.decision === "merge" ? await gateEvidenceOf(sources.shepherd, action.gateId, action.headSha) : undefined;
  return evidence === undefined || typeof evidence === "string" ? (evidence ?? base) : { ...base, evidence };
}

const GATE_EFFECT: Record<ConsoleDecision, (at: string) => string> = {
  merge: (at) => `Approve the merge of ${at}`,
  "await-new-head": (at) => `Wait for the implementer's next pushed head on ${at}; nothing merges`,
  "waive-proof": (at) => `Skip the fix-proof requirement for ${at} only, so Shepherd reviews this head. This tap merges nothing: the merge still needs your Approve merge tap, and a new push asks again`,
};

const gateEffect = (decision: ConsoleDecision, at: string): string => GATE_EFFECT[decision](at);
