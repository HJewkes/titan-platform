import type { FeedbackType, PlaybookStore } from "@titan-design/memory";
import type { LedgerRow } from "./ledger.js";
import { ledgerRef } from "./principles.js";

/** The reflector's judgement of one owner answer against one principle. */
export interface Citation {
  principleId: string;
  verdict: "agrees" | "contradicts";
  reason?: string;
}

export interface PrincipleFeedback {
  principleId: string;
  type: FeedbackType;
  sessionRef: string;
  at: string | undefined;
  reason: string | null;
}

export type FeedbackSkip = "decider-answer" | "unclaimed" | "unscored" | "bulk";

export type FeedbackMapping = { feedback: PrincipleFeedback[] } | { feedback: []; skipped: FeedbackSkip };

/**
 * Only the owner's own per-item answers are evidence; an unoverruled auto-decision is not
 * approval, and one answer that accepted a batch of decisions says nothing about any of them.
 */
function skipReason(row: LedgerRow): FeedbackSkip | null {
  if (row.answered_by === "decider") return "decider-answer";
  if (row.unclaimed) return "unclaimed";
  if (row.outcome === null) return "unscored";
  if (row.outcome === "bulk") return "bulk";
  return null;
}

/** An overrule replaced the decider's answer, so every principle the decider cited was wrong. */
function overruled(row: LedgerRow): Citation[] {
  if (row.answered_by !== "overrule" || row.prediction === null) return [];
  return row.prediction.principleIds.map((principleId) => ({ principleId, verdict: "contradicts", reason: "overruled by the owner" }));
}

/** One vote per principle per row; a contradiction outranks agreement. */
function oneVoteEach(citations: readonly Citation[]): Citation[] {
  const votes = new Map<string, Citation>();
  for (const citation of citations) {
    const prior = votes.get(citation.principleId);
    if (prior === undefined || (prior.verdict === "agrees" && citation.verdict === "contradicts")) votes.set(citation.principleId, citation);
  }
  return [...votes.values()];
}

/** Turn one ledger row into helpful or harmful feedback on the principles it bears on. */
export function feedbackForRow(row: LedgerRow, citations: readonly Citation[]): FeedbackMapping {
  const skipped = skipReason(row);
  if (skipped !== null) return { feedback: [], skipped };
  const at = row.answered_at ?? row.asked_at ?? undefined;
  const feedback = oneVoteEach([...overruled(row), ...citations]).map((c) => ({
    principleId: c.principleId,
    type: c.verdict === "agrees" ? ("helpful" as const) : ("harmful" as const),
    sessionRef: ledgerRef(row.key),
    at,
    reason: c.reason ?? null,
  }));
  return { feedback };
}

export interface ApplyFeedbackReport {
  recorded: PrincipleFeedback[];
  duplicate: PrincipleFeedback[];
  unknown: PrincipleFeedback[];
}

/** Record feedback once per principle and ledger key, so re-running a row changes nothing. */
export function applyFeedback(store: PlaybookStore, feedback: readonly PrincipleFeedback[]): ApplyFeedbackReport {
  const report: ApplyFeedbackReport = { recorded: [], duplicate: [], unknown: [] };
  for (const item of feedback) {
    if (store.get(item.principleId) === undefined) report.unknown.push(item);
    else if (store.feedbackFor(item.principleId).some((e) => e.sessionRef === item.sessionRef)) report.duplicate.push(item);
    else {
      store.recordFeedback(item.principleId, item.type, { sessionRef: item.sessionRef, reason: item.reason, at: item.at });
      report.recorded.push(item);
    }
  }
  return report;
}
