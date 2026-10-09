import { acceptVerdict, boundedFindings, type AwaitVerdictInput, type AwaitVerdictResult, type Presence, type ReviewerReader } from "@titan-design/review-panel";
import { z } from "zod";
import { deadline } from "../workflows/deadline.js";

/** How long an exited or deregistered reviewer may stay gone before its wait ends; its final turn may still be landing on disk. */
export const DEFAULT_EXIT_GRACE_MS = 60_000;
/** A broker restart detaches every agent for a moment, so only a long detach counts as the reviewer leaving. */
export const DEFAULT_DETACH_GRACE_MS = 10 * 60_000;
export const HEAD = /^[0-9a-f]{40}$/;

export interface AwaitVerdictTiming {
  now: () => number;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  pollMs: number;
  timeoutMs: number;
  exitGraceMs?: number;
  detachGraceMs?: number;
}

const fail = (message: string): string => `sh-await-verdict: ${message}`;
const text = (name: string) => z.string({ error: fail(`${name} must be a non-empty string`) }).min(1, fail(`${name} must be a non-empty string`));
const epochMs = (name: string) => z.number({ error: fail(`${name} must be epoch milliseconds`) }).refine(Number.isFinite, fail(`${name} must be epoch milliseconds`));
const positiveInt = fail("pr must be a positive integer");

/** Keys run in the order the checks are reported, so the first issue names the same field the hand-written checks did. */
const AwaitVerdictInputSchema = z.object({
  pr: z.number({ error: positiveInt }).refine((pr) => Number.isSafeInteger(pr) && pr >= 1, positiveInt),
  dispatchedAt: epochMs("dispatchedAt"),
  startedAt: epochMs("startedAt").optional(),
  head: text("head").regex(HEAD, fail("head must be 40 lowercase hex characters")),
  repo: text("repo"),
  reviewerAgentId: text("reviewerAgentId"),
  reviewerSessionId: text("reviewerSessionId"),
});

/** A step input that is not an object reads as one with no fields, so it fails on its first required field. */
const asObject = (raw: unknown): object => (typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw : {});

export function parseAwaitVerdictInput(raw: unknown): AwaitVerdictInput {
  const parsed = AwaitVerdictInputSchema.safeParse(asObject(raw));
  if (!parsed.success) throw new Error(parsed.error.issues[0]?.message);
  const { repo, pr, head, reviewerAgentId, reviewerSessionId, dispatchedAt, startedAt } = parsed.data;
  return { repo, pr, head, reviewerAgentId, reviewerSessionId, dispatchedAt, ...(startedAt !== undefined && { startedAt }) };
}

export const bounded = (result: AwaitVerdictResult): AwaitVerdictResult => (result.kind === "verdict" && result.verdict === "FIX_FIRST" ? { ...result, text: boundedFindings(result.text) } : result);

/** The step that records each head's verdict; a wake with no findings points the fixer at it. */
export const AWAIT_VERDICT_STEP = "sh-await-verdict";

/** The roster fields the wait reads; a `ReviewerAgent` row carries them. */
type Roster = () => Promise<readonly { agentId: string; presence: Presence }[]>;

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
  let gone: { presence: Presence; since: number } | undefined;
  let firstRead = true;
  return async (input) => {
    const rows = await roster().catch(() => undefined);
    if (!rows) return false;
    const atStart = firstRead;
    firstRead = false;
    const presence: Presence = rows.find((row) => row.agentId === input.reviewerAgentId)?.presence ?? "deregistered";
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
  let last: AwaitVerdictResult = { kind: "none" };
  const poll = async () => (last = acceptVerdict(input, await reader.read(input).catch(() => [])));
  for (;;) {
    const result = await poll();
    if (result.kind === "verdict") return result;
    // A verdict can land between the read and the decision that the reviewer is gone, so that decision reads once more.
    if (await silent(input)) return poll();
    if (clock.expired()) return last;
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
