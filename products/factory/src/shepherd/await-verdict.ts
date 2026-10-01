import { parseVerdictBlock } from "@titan-design/session-read";
import { deadline } from "../workflows/deadline.js";
import type { AcceptedVerdict, AwaitVerdictInput, AwaitVerdictResult, AwaitVerdictTiming, ReviewerMessage, ReviewerReader } from "./review.js";

export const HEAD = /^[0-9a-f]{40}$/;
/** The most of a FIX_FIRST message the step output keeps, marker included; the findings come first, so the start is kept. */
export const MAX_FIX_FIRST_TEXT_CHARS = 16_000;
export const FIX_FIRST_TRUNCATED = "\n[truncated]";

export function parseAwaitVerdictInput(raw: unknown): AwaitVerdictInput {
  const input = (raw ?? {}) as Record<string, unknown>;
  const text = (value: unknown, name: string): string => {
    if (typeof value !== "string" || value === "") throw new Error(`sh-await-verdict: ${name} must be a non-empty string`);
    return value;
  };
  const { pr, dispatchedAt } = input;
  if (typeof pr !== "number" || !Number.isSafeInteger(pr) || pr < 1) throw new Error("sh-await-verdict: pr must be a positive integer");
  if (typeof dispatchedAt !== "number" || !Number.isFinite(dispatchedAt)) throw new Error("sh-await-verdict: dispatchedAt must be epoch milliseconds");
  const head = text(input.head, "head");
  if (!HEAD.test(head)) throw new Error("sh-await-verdict: head must be 40 lowercase hex characters");
  return {
    repo: text(input.repo, "repo"),
    pr,
    head,
    reviewerAgentId: text(input.reviewerAgentId, "reviewerAgentId"),
    reviewerSessionId: text(input.reviewerSessionId, "reviewerSessionId"),
    dispatchedAt,
  };
}

function boundedFindings(text: string): string {
  if (text.length <= MAX_FIX_FIRST_TEXT_CHARS) return text;
  return text.slice(0, MAX_FIX_FIRST_TEXT_CHARS - FIX_FIRST_TRUNCATED.length) + FIX_FIRST_TRUNCATED;
}

export const bounded = (result: AwaitVerdictResult): AwaitVerdictResult => (result.kind === "verdict" && result.verdict === "FIX_FIRST" ? { ...result, text: boundedFindings(result.text) } : result);

/**
 * Accepts only the final message of the dispatched agent and session, written after dispatch, whose block names this PR at
 * this head. The reader's fields are not trusted: the locator must point into the dispatched session too, and no message
 * in the read may be written after the final one, so the latest message decides whatever order the reader gave.
 */
export function acceptVerdict(input: AwaitVerdictInput, messages: readonly ReviewerMessage[]): AwaitVerdictResult {
  const final = messages.at(-1);
  if (!final) return { kind: "none" };
  if (final.agentId !== input.reviewerAgentId || final.sessionId !== input.reviewerSessionId) return { kind: "none" };
  if (final.locator?.source?.conversation?.nativeId !== input.reviewerSessionId) return { kind: "none" };
  if (typeof final.writtenAt !== "number" || !(final.writtenAt > input.dispatchedAt)) return { kind: "none" };
  if (messages.some((earlier) => earlier.writtenAt > final.writtenAt)) return { kind: "none" };
  const block = parseVerdictBlock(final.text);
  if (!block.ok) return { kind: "none" };
  if (block.repo !== input.repo || block.pr !== input.pr || block.head !== input.head) return { kind: "none" };
  const accepted: AcceptedVerdict = { kind: "verdict", head: block.head, locator: final.locator, reviewer: { agentId: final.agentId, sessionId: final.sessionId } };
  return block.verdict === "MERGE" ? { ...accepted, verdict: "MERGE" } : { ...accepted, verdict: "FIX_FIRST", text: boundedFindings(final.text) };
}

/** Polls until an acceptable block appears; the deadline ends the wait with `none`, and a failed read counts as nothing yet. */
export async function awaitVerdict(
  reader: ReviewerReader,
  input: AwaitVerdictInput,
  timing: AwaitVerdictTiming,
  signal: AbortSignal,
): Promise<AwaitVerdictResult> {
  const clock = deadline(timing);
  for (;;) {
    const messages = await reader.read(input).catch(() => []);
    const result = acceptVerdict(input, messages);
    if (result.kind === "verdict") return result;
    if (clock.expired()) return { kind: "none" };
    await clock.sleep(timing.pollMs, signal);
  }
}

/**
 * After the wait ran out: a reviewer held up by a permission prompt can still write its verdict, so its final message is
 * read again until it has one, the reviewer has exited, or the grace ends. A read taken after the exit decides.
 */
export async function awaitLateVerdict(
  reader: ReviewerReader,
  exited: () => Promise<boolean>,
  input: AwaitVerdictInput,
  timing: AwaitVerdictTiming,
  signal: AbortSignal,
): Promise<AwaitVerdictResult> {
  const clock = deadline(timing);
  for (;;) {
    const gone = await exited().catch(() => false);
    const result = acceptVerdict(input, await reader.read(input).catch(() => []));
    if (result.kind === "verdict" || gone || clock.expired()) return result;
    await clock.sleep(timing.pollMs, signal);
  }
}
