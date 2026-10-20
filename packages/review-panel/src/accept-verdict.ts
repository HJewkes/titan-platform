import { parseVerdictBlock, refusedLines, type CiPolicy, type SourceTextLocator } from "@titan-design/session-read";
import { hasProbesLine } from "./briefs/adversary.js";
import { DEPTH_FLOOR_REASON } from "./depth-floor.js";
import { fixFirstFindings } from "./fix-first-findings.js";
import { followUpsFields, type FollowUp, type FollowUpsWarning } from "./follow-ups.js";
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
  /** Tasks the reviewer proposed for later, on MERGE and FIX_FIRST alike; never read by the verdict. */
  followUps?: FollowUp[];
  /** Why the reviewer's Follow-ups block was dropped whole; the verdict still counts. */
  followUpsWarning?: FollowUpsWarning;
  /** The profile the accepted message's author was spawned with; absent when neither the dispatch nor the roster says. */
  reviewerProfile?: string;
}

/** Only a FIX_FIRST keeps the reviewer's words, because the implementer has to read them; only a MERGE carries the CI-policy line, and only an unchanged or weakened one. */
export type AwaitVerdictResult = (AcceptedVerdict & { verdict: "MERGE"; ciPolicy?: CiPolicy }) | (AcceptedVerdict & { verdict: "FIX_FIRST"; text: string; closer?: "yes" | "no" }) | { kind: "none"; reason?: string; notice?: string; resetsAt?: number };

/** Why a final message was no verdict: the account's usage limit ended the reviewer's turn, so asking again is pointless until it resets. */
export const USAGE_LIMIT_REASON = "the reviewer hit the account usage limit and wrote no review";
/** Claude Code's synthetic limit message, whole and short; a review that quotes the phrase is longer and still read as a review. */
const USAGE_LIMIT_NOTICE = /^You've hit your [\w -]{0,24}limit\b/;
const MAX_LIMIT_NOTICE_CHARS = 200;
/** The API errors Claude Code records on its usage-limit notice; a synthetic record naming any other error is no limit. */
const LIMIT_ERRORS: ReadonlySet<string> = new Set(["rate_limit", "usage_limit_reached"]);
/**
 * Only a record the client wrote in the model's place can say the account is out of usage, so a reviewer that writes the
 * same words itself, prompted or not, is read as any other unparseable reply.
 */
const isUsageLimitNotice = ({ text, synthetic }: ReviewerMessage): boolean =>
  synthetic !== undefined && (synthetic.apiError === null || LIMIT_ERRORS.has(synthetic.apiError)) && text.length <= MAX_LIMIT_NOTICE_CHARS && USAGE_LIMIT_NOTICE.test(text.trim());
/** A usage-limit result keeps the notice, whose reset time decides how long the account is held. */
export const isUsageLimit = (result: { kind: string; reason?: unknown; notice?: unknown }): boolean =>
  result.kind === "none" && result.reason === USAGE_LIMIT_REASON && typeof result.notice === "string";

const fromDispatch = (input: AwaitVerdictInput, message: ReviewerMessage): boolean =>
  message.agentId === input.reviewerAgentId && message.sessionId === input.reviewerSessionId && message.writtenAt > input.dispatchedAt;

type MalformedNone = { kind: "none"; malformed: Malformed };
const malformedNone = (refusal: Malformed["refusal"], writtenAt: number, text = ""): MalformedNone => {
  const quotes = refusal === "multiple_blocks" || refusal === "ci_policy_malformed" ? refusedLines(text, refusal) : [];
  return { kind: "none", malformed: { refusal, writtenAt, ...(quotes.length > 0 && { quotes }) } };
};

/**
 * Accepts only the final message of the dispatched agent and session, written after dispatch, whose block names this PR at
 * this head. The reader's fields are not trusted: the locator must point into the dispatched session too, and no message
 * in the read may be written after the final one, so the latest message decides whatever order the reader gave.
 * A final message that passes those checks but whose block is refused, or names another repo, PR or head, is `none` with a
 * `malformed` record; silence, a foreign or earlier message, `WAIT` and the client's own usage-limit notice (which no correction can answer) carry none. A MERGE or FIX_FIRST from a session that
 * made no investigative call is `none` with the depth-floor reason; a message the reader did not count is judged as before.
 * A MERGE whose CI-policy line reads malformed is refused for one correction; a weakened reading wins over malformed in the
 * parser, so a weakening is never corrected away. An adversary verdict with no `Probes:` line is refused for one correction too.
 */
export function acceptVerdict(input: AwaitVerdictInput, messages: readonly ReviewerMessage[]): AwaitVerdictResult {
  const final = messages.at(-1);
  if (!final) return { kind: "none" };
  if (final.agentId !== input.reviewerAgentId || final.sessionId !== input.reviewerSessionId) return { kind: "none" };
  if (final.locator?.source?.conversation?.nativeId !== input.reviewerSessionId) return { kind: "none" };
  if (typeof final.writtenAt !== "number" || !(final.writtenAt > input.dispatchedAt)) return { kind: "none" };
  if (messages.some((earlier) => earlier.writtenAt > final.writtenAt)) return { kind: "none" };
  if (isUsageLimitNotice(final)) return { kind: "none", reason: USAGE_LIMIT_REASON, notice: final.text.trim(), ...(typeof final.synthetic?.resetsAt === "number" && { resetsAt: final.synthetic.resetsAt }) };
  const block = parseVerdictBlock(final.text);
  if (!("repo" in block)) return malformedNone(block.reason, final.writtenAt, final.text);
  if (!namesTarget(block, input)) return malformedNone("wrong_target", final.writtenAt);
  if (!block.ok) return { kind: "none", reason: "wait" };
  if (final.investigativeCalls === 0) return { kind: "none", reason: DEPTH_FLOOR_REASON };
  if (input.shape === "adversary" && !hasProbesLine(final.text)) return malformedNone("probes_missing", final.writtenAt);
  if (block.verdict === "MERGE" && block.ciPolicy?.kind === "malformed") return malformedNone("ci_policy_malformed", final.writtenAt, final.text);
  const accepted: AcceptedVerdict = { kind: "verdict", head: block.head, locator: final.locator, reviewer: { agentId: final.agentId, sessionId: final.sessionId }, ownerBrief: parseOwnerBrief(final.text), ...followUpsFields(final.text) };
  return block.verdict === "MERGE" ? { ...accepted, verdict: "MERGE", ...(block.ciPolicy && { ciPolicy: block.ciPolicy }) } : { ...accepted, verdict: "FIX_FIRST", text: fixFirstFindings(input, messages.filter((message) => fromDispatch(input, message)), final.text), ...(block.closer && { closer: block.closer }) };
}
