import { parseVerdictBlock } from "@titan-design/session-read";
import { deadline } from "../workflows/deadline.js";
import type { AcceptedVerdict, AwaitVerdictInput, AwaitVerdictResult, ReviewerMessage, ReviewerReader } from "./review.js";

/** How long an exited or deregistered reviewer may stay gone before its wait ends; its final turn may still be landing on disk. */
export const DEFAULT_EXIT_GRACE_MS = 60_000;
/** A broker restart detaches every agent for a moment, so only a long detach counts as the reviewer leaving. */
export const DEFAULT_DETACH_GRACE_MS = 10 * 60_000;
export const HEAD = /^[0-9a-f]{40}$/;
/** The most of a FIX_FIRST message the step output keeps, marker included; the findings come first, so the start is kept. */
export const MAX_FIX_FIRST_TEXT_CHARS = 16_000;
export const FIX_FIRST_TRUNCATED = "\n[truncated]";

export interface AwaitVerdictTiming {
  now: () => number;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  pollMs: number;
  timeoutMs: number;
  exitGraceMs?: number;
  detachGraceMs?: number;
}

export function parseAwaitVerdictInput(raw: unknown): AwaitVerdictInput {
  const input = (raw ?? {}) as Record<string, unknown>;
  const text = (value: unknown, name: string): string => {
    if (typeof value !== "string" || value === "") throw new Error(`sh-await-verdict: ${name} must be a non-empty string`);
    return value;
  };
  const { pr, dispatchedAt, startedAt } = input;
  if (typeof pr !== "number" || !Number.isSafeInteger(pr) || pr < 1) throw new Error("sh-await-verdict: pr must be a positive integer");
  if (typeof dispatchedAt !== "number" || !Number.isFinite(dispatchedAt)) throw new Error("sh-await-verdict: dispatchedAt must be epoch milliseconds");
  if (startedAt !== undefined && (typeof startedAt !== "number" || !Number.isFinite(startedAt))) throw new Error("sh-await-verdict: startedAt must be epoch milliseconds");
  const head = text(input.head, "head");
  if (!HEAD.test(head)) throw new Error("sh-await-verdict: head must be 40 lowercase hex characters");
  return {
    repo: text(input.repo, "repo"),
    pr,
    head,
    reviewerAgentId: text(input.reviewerAgentId, "reviewerAgentId"),
    reviewerSessionId: text(input.reviewerSessionId, "reviewerSessionId"),
    dispatchedAt,
    ...(startedAt !== undefined && { startedAt }),
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

/** The roster fields the wait reads; a `ReviewerAgent` row carries them. */
type Roster = () => Promise<readonly { agentId: string; presence: string }[]>;

/**
 * Time spent since the reviewer's session was up, or since the intent for a run recorded before that was stamped. The intent
 * comes before a busy broker's wait, so a live reviewer's clock starts at its session. A stamp ahead of this clock counts as just now.
 */
const sinceStart = (timing: AwaitVerdictTiming, input: AwaitVerdictInput): number => Math.max(0, timing.now() - (input.startedAt ?? input.dispatchedAt));

/**
 * True once the dispatched reviewer has been gone for its grace; an unreadable roster says nothing. A reviewer already exited
 * or deregistered at the first read after a (re)start, a grace or more after its start, is gone at once. A detached one is not:
 * a broker restart detaches everyone, so its grace runs from first sight.
 */
function silenceWatch(timing: AwaitVerdictTiming, roster: Roster): (input: AwaitVerdictInput) => Promise<boolean> {
  let gone: { presence: string; since: number } | undefined;
  let firstRead = true;
  return async (input) => {
    const rows = await roster().catch(() => undefined);
    if (!rows) return false;
    const atStart = firstRead;
    firstRead = false;
    const presence = rows.find((row) => row.agentId === input.reviewerAgentId)?.presence ?? "deregistered";
    if (presence !== "exited" && presence !== "detached" && presence !== "deregistered") return (gone = undefined), false;
    const grace = presence === "detached" ? (timing.detachGraceMs ?? DEFAULT_DETACH_GRACE_MS) : (timing.exitGraceMs ?? DEFAULT_EXIT_GRACE_MS);
    if (atStart && presence !== "detached" && sinceStart(timing, input) >= grace) return true;
    if (gone?.presence !== presence) gone = { presence, since: timing.now() };
    return timing.now() - gone.since >= grace;
  };
}

/**
 * Polls until an acceptable block appears; a failed read counts as nothing yet. The deadline, or a reviewer the roster shows
 * gone for its grace, ends the wait with `none`. The deadline counts from the reviewer's start, so a restarted step gets only what is left.
 */
export async function awaitVerdict(
  reader: ReviewerReader,
  input: AwaitVerdictInput,
  timing: AwaitVerdictTiming,
  signal: AbortSignal,
  roster?: Roster,
): Promise<AwaitVerdictResult> {
  const clock = deadline({ ...timing, timeoutMs: Math.max(0, timing.timeoutMs - sinceStart(timing, input)) });
  const silent = roster ? silenceWatch(timing, roster) : async () => false;
  const poll = async () => acceptVerdict(input, await reader.read(input).catch(() => []));
  for (;;) {
    const result = await poll();
    if (result.kind === "verdict") return result;
    // A verdict can land between the read and the decision that the reviewer is gone, so that decision reads once more.
    if (await silent(input)) return poll();
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
