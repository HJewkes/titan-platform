import { BrokerUnavailableError, DispatchError, DispatchTimeoutError } from "@titan-design/agent-dispatch";
import type { AgentIdentity } from "@titan-design/authority";
import { parseVerdictBlock } from "@titan-design/session-read";
import { z } from "zod";
import { deadline } from "../workflows/deadline.js";
import { bounded, type AwaitVerdictTiming } from "./await-verdict.js";
import { redactCredentials } from "../redact.js";
import { consoleTextOf, failureOf } from "./error-class.js";
import { holdClassOf } from "./g10-release.js";
import { ReviewerAskTimedOut, ReviewerBrokerBusy, ReviewerBrokerDown, clearReviewWait, noteReviewWait } from "./review-wait.js";
import type { AwaitVerdictInput, AwaitVerdictResult, ReviewTarget, ReviewWiring, ReviewerAgent, ReviewerMessage, ReviewerReader } from "./review.js";
import type { OwnerOverride } from "./override-stats.js";
import type { Registration } from "./store.js";
import { rosterTie, type SeatRow, type SeatTarget } from "./seat-tie.js";
import { DamagedTranscriptError, ownRecordsNameOtherPr, reviewsThisPr, type NameRead } from "./seat-evidence.js";

export { DamagedTranscriptError } from "./seat-evidence.js";
import { fixFirstFindings, namesTarget } from "@titan-design/review-panel";

/** The reviewer a hold waits on, from `hold --reviewer` alone; a name in the hold's reason text is never read as one. */
export function externalReviewer(registration: Registration | undefined): string | undefined {
  if (!registration?.held) return undefined;
  return registration.holdReviewer ?? undefined;
}

/** A `g10-adversary` hold needs two independent MERGEs, the seat reviewer's and Shepherd's own, so its named reviewer is never adopted as Shepherd's. */
const OWN_REVIEW_HOLDS: ReadonlySet<string> = new Set(["g10-adversary"]);

/** The hold's named reviewer when the run takes its verdict as Shepherd's review; the hold satisfier still reads it under every class. */
export function adoptedReviewer(registration: Registration | undefined): string | undefined {
  const holdClass = holdClassOf(registration?.holdReason);
  return holdClass !== undefined && OWN_REVIEW_HOLDS.has(holdClass) ? undefined : externalReviewer(registration);
}

export interface ExternalVerdictInput {
  repo: string;
  pr: number;
  head: string;
  external: string;
}

export function isExternalVerdictInput(raw: unknown): raw is ExternalVerdictInput {
  return typeof raw === "object" && raw !== null && typeof (raw as { external?: unknown }).external === "string";
}

/** The newest message of the reviewer's latest session whose verdict block names this PR at this head; a WAIT there, or beside a MERGE of the same time, is no verdict. */
export function acceptExternalVerdict(input: ExternalVerdictInput, row: ReviewerAgent, messages: readonly ReviewerMessage[]): AwaitVerdictResult {
  const own = messages.filter((message) => message.agentId === row.agentId && message.sessionId === row.sessionId);
  const atHead = own.flatMap((message) => {
    const block = parseVerdictBlock(message.text);
    const named = "repo" in block && namesTarget(block, input);
    return named ? [{ message, block }] : [];
  });
  const merges = (entry: { block: { ok: boolean } }) => (entry.block.ok ? 1 : 0);
  const newest = atHead.sort((a, b) => b.message.writtenAt - a.message.writtenAt || merges(a) - merges(b))[0];
  if (!newest) return { kind: "none" };
  const { message, block } = newest;
  if (!block.ok) return { kind: "none", reason: "wait" };
  const accepted = { kind: "verdict" as const, head: block.head, locator: message.locator, reviewer: { agentId: row.agentId, sessionId: row.sessionId } };
  return block.verdict === "MERGE" ? { ...accepted, verdict: "MERGE", ...(block.ciPolicy && { ciPolicy: block.ciPolicy }) } : { ...accepted, verdict: "FIX_FIRST", text: fixFirstFindings(input, own, message.text), ...(block.closer && { closer: block.closer }) };
}

/** A name can span sessions; the last row the roster lists with a session holds it. */
export function latestSession(name: string, roster: readonly ReviewerAgent[]): ReviewerAgent | undefined {
  return roster.filter((agent) => agent.name === name && agent.sessionId !== "").at(-1);
}

/** A `ReviewerReader` whose seat read can take the roster its caller already holds, so a check reads the roster once. */
export type SeatReader = Omit<ReviewerReader, "readSeat"> & {
  readSeat?: (input: AwaitVerdictInput, roster?: readonly ReviewerAgent[]) => Promise<readonly ReviewerMessage[]>;
};

/**
 * A named reviewer's session read as a seat reviewer's is: at any presence, `chat_send` messages counted, and cached until
 * the transcript changes. A reader with no seat read falls back to the finished-session read. A failure propagates.
 */
export function readNamedReviewer(reader: SeatReader, input: AwaitVerdictInput, roster?: readonly ReviewerAgent[]): Promise<readonly ReviewerMessage[]> {
  return reader.readSeat ? reader.readSeat(input, roster) : reader.read(input);
}

/** The awaiting release-side read: any failure, a damaged transcript included, is no messages. A damaged transcript's complete records can hold a MERGE written before a cut-off FIX_FIRST, so they may only block a merge (the seat read), never release one. */
function readNamedReviewerOrNone(reader: ReviewerReader, input: AwaitVerdictInput): Promise<readonly ReviewerMessage[]> {
  return readNamedReviewer(reader, input).catch((): readonly ReviewerMessage[] => []);
}

/** Polls the hold's reviewer for a verdict at this head; Shepherd starts nobody, and the deadline ends the wait with `none`. */
export async function awaitExternalVerdict(roster: () => Promise<readonly ReviewerAgent[]>, reader: ReviewerReader, input: ExternalVerdictInput, timing: AwaitVerdictTiming, signal: AbortSignal): Promise<AwaitVerdictResult> {
  const clock = deadline(timing);
  for (;;) {
    const row = latestSession(input.external, await roster().catch(() => []));
    if (row) {
      const read = { repo: input.repo, pr: input.pr, head: input.head, reviewerAgentId: row.agentId, reviewerSessionId: row.sessionId, dispatchedAt: 0 };
      const result = acceptExternalVerdict(input, row, await readNamedReviewerOrNone(reader, read));
      if (result.kind === "verdict") return result;
    }
    if (clock.expired()) return { kind: "none" };
    await clock.sleep(timing.pollMs, signal);
  }
}

/** A seat's independent reviewer, as the seats name them; Shepherd's own reviewers are named `rv-*` and never match. */
export const SEAT_REVIEWER = /-review(-r[0-9]+)?$/;

interface AtHead {
  message: ReviewerMessage;
  verdict: "MERGE" | "FIX_FIRST" | "WAIT";
}

/** The newest verdict block naming this PR at this head; GitHub repo names ignore case, and on a tie in time a FIX_FIRST or WAIT beats a MERGE. */
export function newestAtHead(target: ReviewTarget, messages: readonly ReviewerMessage[]): AtHead | undefined {
  let newest: AtHead | undefined;
  for (const message of messages) {
    const block = parseVerdictBlock(message.text);
    const verdict = block.ok ? block.verdict : block.reason === "wait" ? "WAIT" : undefined;
    if (!verdict || !("repo" in block) || !Number.isFinite(message.writtenAt)) continue;
    if (!namesTarget(block, target)) continue;
    const later = !newest || message.writtenAt > newest.message.writtenAt || (message.writtenAt === newest.message.writtenAt && verdict !== "MERGE");
    if (later) newest = { message, verdict };
  }
  return newest;
}

/** Every session the roster lists under one name; a message the reader attributes to any other session is dropped. A damaged session still gives its complete records. */
async function readReviewer(reader: SeatReader, target: ReviewTarget, rows: readonly SeatRow[], listed: readonly ReviewerAgent[]): Promise<NameRead> {
  const read = (row: ReviewerAgent) => readNamedReviewer(reader, { ...target, reviewerAgentId: row.agentId, reviewerSessionId: row.sessionId, dispatchedAt: 0 }, listed);
  const owned = (message: ReviewerMessage) => rows.some((row) => row.agentId === message.agentId && row.sessionId === message.sessionId);
  const messages: ReviewerMessage[] = [];
  const failures: unknown[] = [];
  const failedRows: SeatRow[] = [];
  const settled = (row: SeatRow) => read(row).then((value) => ({ row, value }), (reason: unknown) => ({ row, reason }));
  for (const outcome of await Promise.all(rows.map(settled))) {
    if ("value" in outcome) {
      messages.push(...outcome.value);
      continue;
    }
    failures.push(outcome.reason);
    failedRows.push(outcome.row);
    if (outcome.reason instanceof DamagedTranscriptError) messages.push(...outcome.reason.readable);
  }
  return { messages: messages.filter(owned), failures, failedRows };
}

/**
 * `clear` lets the MERGE stand; a FIX_FIRST sends the head back; a `none` with a reason is a read that failed, or a seat WAIT
 * (`wait`, naming the `seat`), and blocks the head too. `retry` marks a failed read that may succeed if asked again.
 */
export type SeatCheck = Extract<AwaitVerdictResult, { verdict: "FIX_FIRST" }> | { kind: "none"; reason: string; wait?: true; retry?: true; seat?: string } | { kind: "clear"; merged?: string };

/** The broker's own failures that clear with time; a permission, missing-file or parse failure reads the same every time. */
const TRANSIENT = [ReviewerAskTimedOut, ReviewerBrokerDown, ReviewerBrokerBusy, DispatchTimeoutError, BrokerUnavailableError];

const transient = (error: unknown): boolean =>
  TRANSIENT.some((kind) => error instanceof kind) || /^HTTP 5\d\d$/.test(failureOf(error));

const retryIf = (clears: boolean) => (clears ? { retry: true as const } : {});

const DETAIL_CHARS = 200;
const URL_TEXT = /\bhttps?:\/\/\S+/g;
const HOME_DIR = /\/(?:Users|home)\/[^/\s]+/g;

/** agent-dispatch's errors carry the agent-chat CLI's own words, which say why it failed; any other error's text may hold anything, so it stays its class. */
function failureText(error: unknown): string {
  const kind = failureOf(error);
  if (!(error instanceof DispatchError)) return kind;
  const text = redactCredentials(consoleTextOf(error)).replace(URL_TEXT, "[url]").replace(HOME_DIR, "~").replace(/\s+/g, " ").trim();
  if (text === "") return kind;
  return `${kind}: ${text.length <= DETAIL_CHARS ? text : `${text.slice(0, DETAIL_CHARS)}…`}`;
}

const unread = (name: string, failure: unknown, clears: boolean): SeatCheck => {
  const reason = `seat check: the transcript of ${name} could not be read: ${failureText(failure)}`;
  return { kind: "none", reason, ...retryIf(clears) };
};

/**
 * A failed read of a reviewer a brief or verdict block ties to this PR blocks. A failure that may clear blocks with a retry,
 * so the seat wait bounds it. One that reads the same every time clears with a warning only on evidence that the reviewer is
 * another PR's: every failed session is damaged and its own records name a PR with another number, or the failed sessions' name stem or
 * directory is another registered PR's implementer or branch. A row of the name tied to this PR still blocks. With no evidence either
 * way it blocks with a retry, so the seat wait holds the MERGE, and the reason names what was missing.
 */
function failedRead(name: string, target: SeatTarget, read: NameRead, rows: readonly SeatRow[], warn: (line: string) => void): SeatCheck | undefined {
  const hards = read.failures.filter((each) => !(each instanceof DamagedTranscriptError));
  const failure = hards[0] ?? read.failures[0];
  if (failure === undefined) return undefined;
  if (reviewsThisPr(target, read)) return unread(name, failure, hards.length > 0 && hards.every(transient));
  const clearing = hards.find(transient);
  if (clearing !== undefined) return unread(name, clearing, true);
  const tieOf = (of: readonly SeatRow[]) => rosterTie(target, of, (stem) => stem.replace(SEAT_REVIEWER, ""));
  const tie = tieOf(rows).kind === "own" ? { kind: "own" as const } : tieOf(read.failedRows);
  if (tie.kind !== "own" && read.failures.every((each) => ownRecordsNameOtherPr(target, each))) return untied(name, target, "its records name another PR", failure, warn);
  if (tie.kind === "other") return untied(name, target, `the roster ties it to ${tie.pr}'s registration`, failure, warn);
  const why = tie.kind === "own" ? "the roster ties it to this PR's implementer" : `nothing says whose reviewer it is (no record names a PR; ${tie.missing})`;
  return { kind: "none", reason: `seat check: the transcript of ${name} could not be read and ${why}: ${failureText(failure)}`, ...retryIf(tie.kind === "none") };
}

function untied(name: string, target: ReviewTarget, evidence: string, failure: unknown, warn: (line: string) => void): undefined {
  warn(`seat check: ${name} is not the reviewer of ${target.repo}#${target.pr} (${evidence}), so its unreadable transcript does not block it: ${failureText(failure)}`);
  return undefined;
}

function sentBack(name: string, target: ReviewTarget, message: ReviewerMessage, messages: readonly ReviewerMessage[]): SeatCheck {
  const text = fixFirstFindings(target, messages, message.text, `Seat reviewer ${name} said FIX_FIRST at this head.\n\n`);
  return { kind: "verdict", verdict: "FIX_FIRST", head: target.head, locator: message.locator, reviewer: { agentId: message.agentId, sessionId: message.sessionId }, text };
}

/**
 * Fails closed: an unreadable roster blocks the head, and so does a seat reviewer's transcript that cannot be read, unless its
 * readable records or the roster show it is another PR's reviewer (see `failedRead`). A reviewer with no finished transcript
 * yet reads as no verdict. Any FIX_FIRST is preferred over a failed read, since a fixer can act on it.
 */
export async function seatFixFirst(roster: () => Promise<readonly ReviewerAgent[]>, reader: SeatReader, target: SeatTarget, warn: (line: string) => void = console.warn): Promise<SeatCheck> {
  let listed: readonly ReviewerAgent[];
  try {
    listed = await roster();
  } catch (error) {
    return { kind: "none", reason: `seat check: the roster could not be read: ${failureText(error)}`, ...retryIf(transient(error)) };
  }
  const rows = listed.filter((row) => SEAT_REVIEWER.test(row.name) && row.sessionId !== "");
  let failed: SeatCheck | undefined;
  let merged: string | undefined;
  for (const name of new Set(rows.map((row) => row.name))) {
    const named = rows.filter((row) => row.name === name);
    const read = await readReviewer(reader, target, named, listed);
    const newest = newestAtHead(target, read.messages);
    if (newest?.verdict === "FIX_FIRST") return sentBack(name, target, newest.message, read.messages);
    if (newest?.verdict === "WAIT") return { kind: "none", reason: `seat check: ${name} said WAIT at ${target.head}, so its required checks had not finished`, wait: true, seat: name };
    if (newest?.verdict === "MERGE") merged ??= name;
    failed ??= failedRead(name, target, read, named, warn);
  }
  return failed ?? { kind: "clear", ...(merged !== undefined && { merged }) };
}

type SeatWaitTiming = Pick<AwaitVerdictTiming, "now" | "sleep" | "pollMs" | "timeoutMs">;

/** How long Shepherd's own MERGE waits on a seat WAIT, and the step's signal that ends the wait early. */
interface SeatWait {
  timing: SeatWaitTiming;
  signal: AbortSignal;
}

type OwnMerge = Extract<AwaitVerdictResult, { verdict: "MERGE" }>;

/** Shepherd's own MERGE that a seat WAIT still held when the seat wait ran out; the next round re-checks the seat against it instead of reviewing again. */
interface SeatHeldNone {
  kind: "none";
  reason: string;
  seatHeld: OwnMerge;
  seat?: string;
}

/** A seat's `none` as the step records it, carrying the seat that said WAIT so a reader can name it. */
type SeatNone = { kind: "none"; reason: string; seat?: string };

/** A WAIT, or a read the broker failed for a while, can still settle; a damaged transcript or a refused read cannot. */
const unsettled = (check: SeatCheck): boolean => check.kind === "none" && (check.wait === true || check.retry === true);

/**
 * Re-reads the seat check while it answers WAIT or a read failed in a way that can clear, so a seat waiting on CI settles into
 * its verdict and a broker timeout does not cost the own MERGE; the deadline returns the standing check. The hold shows in the view,
 * because the step records nothing until it ends.
 */
async function awaitSeatSettled(roster: () => Promise<readonly ReviewerAgent[]>, reader: ReviewerReader, target: SeatTarget, timing: SeatWaitTiming, signal: AbortSignal, warn?: (line: string) => void): Promise<SeatCheck> {
  const clock = deadline(timing);
  try {
    for (;;) {
      const check = await seatFixFirst(roster, reader, target, warn);
      if (!unsettled(check) || clock.expired()) return check;
      if (check.kind === "none") noteReviewWait(target.repo, target.pr, `holding Shepherd's MERGE at ${target.head} on the seat check: ${check.reason}`);
      await clock.sleep(timing.pollMs, signal);
    }
  } finally {
    clearReviewWait(target.repo, target.pr);
  }
}

/**
 * A MERGE stands only while the seat check is clear at the same head. A seat's FIX_FIRST over it is a G10 disagreement,
 * recorded on the result. With `seatWait`, a seat WAIT or a read that can clear is waited out, and one that outlasts it holds the MERGE
 * as `seatHeld`, so the next round re-checks the seat instead of reviewing again. A damaged transcript blocks with no hold.
 */
export async function unlessSeatFixFirst(roster: () => Promise<readonly ReviewerAgent[]>, reader: ReviewerReader, target: SeatTarget, result: AwaitVerdictResult, warn?: (line: string) => void, now: () => number = Date.now, seatWait?: SeatWait): Promise<AwaitVerdictResult> {
  if (result.kind !== "verdict" || result.verdict !== "MERGE") return result;
  const check = seatWait ? await awaitSeatSettled(roster, reader, target, seatWait.timing, seatWait.signal, warn) : await seatFixFirst(roster, reader, target, warn);
  if (check.kind === "clear") return result;
  if (check.kind === "verdict") return { ...check, ownerOverride: disagreement(target.head, "MERGE", "FIX_FIRST", now) };
  const none: SeatNone = { kind: "none", reason: check.reason, ...(check.seat !== undefined && { seat: check.seat }) };
  return seatWait && unsettled(check) ? held(none, result) : none;
}

const held = (none: SeatNone, seatHeld: OwnMerge): SeatHeldNone => ({ ...none, seatHeld });

const disagreement = (head: string, shepherd: "MERGE" | "FIX_FIRST", other: string, now: () => number): Omit<OwnerOverride, "trigger"> & { trigger: "g10-disagree" } => ({ trigger: "g10-disagree", head, shepherd, other, at: now() });

type VerdictStep = (raw: unknown, signal: AbortSignal) => Promise<AwaitVerdictResult>;

const SpawnedProfile = z.looseObject({ reviewerAgentId: z.string(), reviewerProfile: z.string().min(1) });

/** The profile Shepherd spawned its own reviewer with, else the roster's for whoever wrote the verdict; an unreadable roster leaves it unknown. */
async function authorProfile(raw: unknown, author: AgentIdentity, roster: () => Promise<readonly ReviewerAgent[]>): Promise<string | undefined> {
  const spawned = SpawnedProfile.safeParse(raw);
  if (spawned.success && spawned.data.reviewerAgentId === author.agentId) return spawned.data.reviewerProfile;
  const rows = await roster().catch((): readonly ReviewerAgent[] => []);
  return rows.find((row) => row.agentId === author.agentId && row.sessionId === author.sessionId)?.profile;
}

/** Every acceptor's verdict passes here, so the recorded step names the profile of the reviewer whose message it took. */
async function withAuthorProfile(raw: unknown, result: AwaitVerdictResult, roster: () => Promise<readonly ReviewerAgent[]>): Promise<AwaitVerdictResult> {
  if (result.kind !== "verdict") return result;
  const profile = await authorProfile(raw, result.reviewer, roster);
  return profile === undefined ? result : { ...result, reviewerProfile: profile };
}

const DispatchedReviewer = z.looseObject({ reviewerAgentId: z.string().min(1), reviewerSessionId: z.string().min(1) });

/**
 * The step records a verdict only as its own dispatched reviewer's, so a seat that counts Shepherd's verdict as a second
 * independent review never reads its own reviewer there. An input naming no reviewer cannot vouch for one, so it fails closed.
 * External mode started nobody and takes the named reviewer's verdict as its own.
 */
function authoredByDispatched(raw: unknown, result: AwaitVerdictResult): AwaitVerdictResult {
  if (result.kind !== "verdict" || isExternalVerdictInput(raw)) return result;
  const input = DispatchedReviewer.safeParse(raw);
  const { agentId, sessionId } = result.reviewer;
  if (input.success && input.data.reviewerAgentId === agentId && input.data.reviewerSessionId === sessionId) return result;
  return { kind: "none", reason: `verdict author ${agentId} is not the dispatched reviewer${input.success ? ` ${input.data.reviewerAgentId}` : ""}` };
}

/**
 * Inside the step, so the replay reads the recorded outcome; with no dispatch wired there is no roster to read seat reviewers from. With
 * `seatWaitTiming`, a seat WAIT over the MERGE is waited out under the step's signal. `ownersOf` names who Shepherd registered as opening the PR and every other PR.
 */
export function seatVetoed(
  wiring: ReviewWiring | undefined,
  body: VerdictStep,
  now: () => number = Date.now,
  seatWaitTiming?: SeatWaitTiming,
  ownersOf?: (target: ReviewTarget) => Pick<SeatTarget, "owner" | "others">,
): VerdictStep {
  return async (raw, signal) => {
    const result = authoredByDispatched(raw, await body(raw, signal));
    const dispatch = wiring?.dispatch;
    if (!dispatch) return result;
    const { repo, pr, head } = raw as ReviewTarget;
    const target: SeatTarget = { repo, pr, head, ...ownersOf?.({ repo, pr, head }) };
    const roster = () => dispatch.roster();
    const seatWait = seatWaitTiming && { timing: seatWaitTiming, signal };
    const vetoed = await unlessSeatFixFirst(roster, wiring.reader, target, result, undefined, now, seatWait);
    return withAuthorProfile(raw, bounded(vetoed === result ? await seatMergeOverFixFirst(roster, wiring.reader, target, result, now) : vetoed), roster);
  };
}

/** The reverse G10 disagreement: Shepherd's own review sent the head back while a seat reviewer said MERGE at it. The verdict stands. */
async function seatMergeOverFixFirst(roster: () => Promise<readonly ReviewerAgent[]>, reader: ReviewerReader, target: SeatTarget, result: AwaitVerdictResult, now: () => number): Promise<AwaitVerdictResult> {
  if (result.kind !== "verdict" || result.verdict !== "FIX_FIRST") return result;
  const check = await seatFixFirst(roster, reader, target);
  return check.kind === "clear" && check.merged !== undefined ? { ...result, ownerOverride: disagreement(target.head, "FIX_FIRST", "MERGE", now) } : result;
}
