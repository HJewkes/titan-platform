import { parseVerdictBlock, type SourceTextLocator } from "@titan-design/session-read";
import { DEPTH_FLOOR_REASON } from "./depth-floor.js";
import { fixFirstFindings } from "./fix-first-findings.js";
import type { AwaitVerdictInput, ReviewerMessage } from "./ports.js";
import { parseOwnerBrief, type Malformed, type OwnerBrief } from "./verdict-schemas.js";
import { namesTarget } from "./verdict-target.js";

export interface AcceptedVerdict {
  kind: "verdict";
  head: string;
  locator: SourceTextLocator;
  /** The author of the accepted message, as the reader attributed it. */
  reviewer: { agentId: string; sessionId: string };
  /** The reviewer's OWNER-BRIEF block, or null when it wrote none or it did not parse; never read by the verdict. */
  ownerBrief?: OwnerBrief | null;
  /** The profile the accepted message's author was spawned with; absent when neither the dispatch nor the roster says. */
  reviewerProfile?: string;
}

/** Only a FIX_FIRST keeps the reviewer's words, because the implementer has to read them. */
export type AwaitVerdictResult = (AcceptedVerdict & { verdict: "MERGE" }) | (AcceptedVerdict & { verdict: "FIX_FIRST"; text: string; closer?: "yes" | "no" }) | { kind: "none"; reason?: string };

/** Why a final message was no verdict: the account's usage limit ended the reviewer's turn, so asking again is pointless until it resets. */
export const USAGE_LIMIT_REASON = "the reviewer hit the account usage limit and wrote no review";
/** Claude Code's synthetic limit message, whole and short; a review that quotes the phrase is longer and still read as a review. */
const USAGE_LIMIT_NOTICE = /^You've hit your [\w -]{0,24}limit\b/;
const MAX_LIMIT_NOTICE_CHARS = 200;
const isUsageLimitNotice = (text: string): boolean => text.length <= MAX_LIMIT_NOTICE_CHARS && USAGE_LIMIT_NOTICE.test(text.trim());

const fromDispatch = (input: AwaitVerdictInput, message: ReviewerMessage): boolean =>
  message.agentId === input.reviewerAgentId && message.sessionId === input.reviewerSessionId && message.writtenAt > input.dispatchedAt;

type MalformedNone = { kind: "none"; malformed: Malformed };
const malformedNone = (refusal: Malformed["refusal"], writtenAt: number): MalformedNone => ({ kind: "none", malformed: { refusal, writtenAt } });

/**
 * Accepts only the final message of the dispatched agent and session, written after dispatch, whose block names this PR at
 * this head. The reader's fields are not trusted: the locator must point into the dispatched session too, and no message
 * in the read may be written after the final one, so the latest message decides whatever order the reader gave.
 * A final message that passes those checks but whose block is refused, or names another repo, PR or head, is `none` with a
 * `malformed` record; silence, a foreign or earlier message, `WAIT` and a usage-limit notice (which no correction can answer) carry none. A MERGE or FIX_FIRST from a session that
 * made no investigative call is `none` with the depth-floor reason; a message the reader did not count is judged as before.
 */
export function acceptVerdict(input: AwaitVerdictInput, messages: readonly ReviewerMessage[]): AwaitVerdictResult {
  const final = messages.at(-1);
  if (!final) return { kind: "none" };
  if (final.agentId !== input.reviewerAgentId || final.sessionId !== input.reviewerSessionId) return { kind: "none" };
  if (final.locator?.source?.conversation?.nativeId !== input.reviewerSessionId) return { kind: "none" };
  if (typeof final.writtenAt !== "number" || !(final.writtenAt > input.dispatchedAt)) return { kind: "none" };
  if (messages.some((earlier) => earlier.writtenAt > final.writtenAt)) return { kind: "none" };
  if (isUsageLimitNotice(final.text)) return { kind: "none", reason: USAGE_LIMIT_REASON };
  const block = parseVerdictBlock(final.text);
  if (!("repo" in block)) return malformedNone(block.reason, final.writtenAt);
  if (!namesTarget(block, input)) return malformedNone("wrong_target", final.writtenAt);
  if (!block.ok) return { kind: "none", reason: "wait" };
  if (final.investigativeCalls === 0) return { kind: "none", reason: DEPTH_FLOOR_REASON };
  const accepted: AcceptedVerdict = { kind: "verdict", head: block.head, locator: final.locator, reviewer: { agentId: final.agentId, sessionId: final.sessionId }, ownerBrief: parseOwnerBrief(final.text) };
  return block.verdict === "MERGE" ? { ...accepted, verdict: "MERGE" } : { ...accepted, verdict: "FIX_FIRST", text: fixFirstFindings(input, messages.filter((message) => fromDispatch(input, message)), final.text), ...(block.closer && { closer: block.closer }) };
}
