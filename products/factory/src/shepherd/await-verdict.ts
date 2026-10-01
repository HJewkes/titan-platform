import type { AgentIdentity } from "@titan-design/authority";
import { parseVerdictBlock, type SourceTextLocator } from "@titan-design/session-read";
import { deadline } from "../workflows/deadline.js";

/** How long an exited or deregistered reviewer may stay gone before its wait ends; its final turn may still be landing on disk. */
export const DEFAULT_EXIT_GRACE_MS = 60_000;
/** A broker restart detaches every agent for a moment, so only a long detach counts as the reviewer leaving. */
export const DEFAULT_DETACH_GRACE_MS = 10 * 60_000;
/** The most of a FIX_FIRST message the step output keeps, marker included; the findings come first, so the start is kept. */
export const MAX_FIX_FIRST_TEXT_CHARS = 16_000;
export const FIX_FIRST_TRUNCATED = "\n[truncated]";
export const HEAD_SHA = /^[0-9a-f]{40}$/;

export interface AwaitVerdictInput {
  repo: string;
  pr: number;
  head: string;
  reviewerAgentId: string;
  reviewerSessionId: string;
  /** Epoch milliseconds. */
  dispatchedAt: number;
}

/** One assistant message, attributed by the reader to the agent and session it came from. */
export interface ReviewerMessage {
  agentId: string;
  sessionId: string;
  /** Epoch milliseconds. */
  writtenAt: number;
  text: string;
  locator: SourceTextLocator;
}

/** The assistant messages of the dispatched reviewer's session, oldest first; the last one is the final message. */
export interface ReviewerReader {
  read(input: AwaitVerdictInput): Promise<readonly ReviewerMessage[]>;
}

interface AcceptedVerdict {
  kind: "verdict";
  head: string;
  locator: SourceTextLocator;
  /** The author of the accepted message, as the reader attributed it. */
  reviewer: AgentIdentity;
}

/** Only a FIX_FIRST keeps the reviewer's words, because the implementer has to read them. `silence` says why a dispatched reviewer gave none. */
export type AwaitVerdictResult = (AcceptedVerdict & { verdict: "MERGE" }) | (AcceptedVerdict & { verdict: "FIX_FIRST"; text: string }) | { kind: "none"; silence?: string };

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
  const { pr, dispatchedAt } = input;
  if (typeof pr !== "number" || !Number.isSafeInteger(pr) || pr < 1) throw new Error("sh-await-verdict: pr must be a positive integer");
  if (typeof dispatchedAt !== "number" || !Number.isFinite(dispatchedAt)) throw new Error("sh-await-verdict: dispatchedAt must be epoch milliseconds");
  const head = text(input.head, "head");
  if (!HEAD_SHA.test(head)) throw new Error("sh-await-verdict: head must be 40 lowercase hex characters");
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

/** Why the dispatched reviewer is gone for good, or undefined while it may still answer; an unreadable roster says nothing. */
function silenceWatch(timing: AwaitVerdictTiming, roster: Roster): (input: AwaitVerdictInput) => Promise<string | undefined> {
  let gone: { presence: string; since: number } | undefined;
  return async (input) => {
    const rows = await roster().catch(() => undefined);
    if (!rows) return undefined;
    const presence = rows.find((row) => row.agentId === input.reviewerAgentId)?.presence ?? "deregistered";
    if (presence !== "exited" && presence !== "detached" && presence !== "deregistered") return void (gone = undefined);
    if (gone?.presence !== presence) gone = { presence, since: timing.now() };
    const grace = presence === "detached" ? (timing.detachGraceMs ?? DEFAULT_DETACH_GRACE_MS) : (timing.exitGraceMs ?? DEFAULT_EXIT_GRACE_MS);
    if (timing.now() - gone.since < grace) return undefined;
    return `${presence === "detached" ? "stayed detached" : presence} without a verdict for ${input.head}`;
  };
}

/**
 * Polls until an acceptable block appears; a failed read counts as nothing yet. The deadline, or a reviewer the roster
 * shows gone for its grace, ends the wait with `none` and says why.
 */
export async function awaitVerdict(
  reader: ReviewerReader,
  input: AwaitVerdictInput,
  timing: AwaitVerdictTiming,
  signal: AbortSignal,
  roster?: Roster,
): Promise<AwaitVerdictResult> {
  const clock = deadline(timing);
  const silent = roster ? silenceWatch(timing, roster) : async () => undefined;
  for (;;) {
    const messages = await reader.read(input).catch(() => []);
    const result = acceptVerdict(input, messages);
    if (result.kind === "verdict") return result;
    const silence = await silent(input);
    if (silence) return { kind: "none", silence };
    if (clock.expired()) return { kind: "none", silence: `gave no verdict for ${input.head} within ${timing.timeoutMs} ms` };
    await clock.sleep(timing.pollMs, signal);
  }
}
