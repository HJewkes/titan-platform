import { BrokerUnavailableError, DispatchTimeoutError } from "@titan-design/agent-dispatch";
import { deadline, type DeadlineTiming } from "../workflows/deadline.js";
import { errorClass, failureOf } from "./error-class.js";
import { ReviewSuperseded } from "./review-dispatcher.js";

const minutes = (ms: number) => `${Math.round(ms / 6_000) / 10} min`;

/** The port throws this when the broker cannot be reached: nothing was asked of it, so asking again is safe. */
export class ReviewerBrokerDown extends Error {
  override readonly name = "ReviewerBrokerDown";
}

/** The port throws this when an agent-chat call outlasted its timeout; the call may still have landed, so it is never asked again blind. */
export class ReviewerAskTimedOut extends Error {
  override readonly name = "ReviewerAskTimedOut";
}

export interface PollTiming {
  now: () => number;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  pollMs: number;
}

/** Waits out a broker that is down; any other failure is the caller's to handle. */
export async function whileBrokerDown<T>(timing: PollTiming, signal: AbortSignal, ask: () => Promise<T>): Promise<T> {
  for (;;) {
    signal.throwIfAborted();
    try {
      return await ask();
    } catch (error) {
      if (!(error instanceof ReviewerBrokerDown)) throw error;
    }
    await timing.sleep(timing.pollMs, signal);
  }
}

/** Each wait for an unreachable broker doubles from the step's poll, up to this. */
const BROKER_DOWN_LONGEST_WAIT_MS = 2 * 60_000;
/** A boot race or a broker restart clears well inside this; a broker still unreachable after it is an outage the seat must hear of (TP-4641). */
export const DEFAULT_BROKER_DOWN_WAIT_MS = 15 * 60_000;

/** The broker stayed unreachable for the whole wait; the message is built from the budget alone, since it becomes a stored hold reason. */
export class ReviewerBrokerStillDown extends Error {
  override readonly name = "ReviewerBrokerStillDown";

  constructor(cause: ReviewerBrokerDown, budgetMs: number) {
    super(`broker unavailable (no broker answered for ${minutes(budgetMs)})`, { cause });
  }
}

export type BrokerDownTiming = PollTiming & { brokerDownWaitMs: number };

/** Waits out a broker that is down, doubling each wait, until `brokerDownWaitMs` has passed; any other failure is the caller's to handle. */
export async function whileBrokerBooting<T>(timing: BrokerDownTiming, signal: AbortSignal, ask: () => Promise<T>): Promise<T> {
  const startedAt = timing.now();
  for (let wait = timing.pollMs; ; wait = Math.min(wait * 2, BROKER_DOWN_LONGEST_WAIT_MS)) {
    signal.throwIfAborted();
    try {
      return await ask();
    } catch (error) {
      if (!(error instanceof ReviewerBrokerDown)) throw error;
      const left = timing.brokerDownWaitMs - (timing.now() - startedAt);
      if (left <= 0) throw new ReviewerBrokerStillDown(error, timing.brokerDownWaitMs);
      await timing.sleep(Math.min(wait, left), signal);
    }
  }
}

/**
 * The roster read stayed timed out for the whole session-start window, so no reviewer could be chosen and none was started.
 * The message is built from the class and the budget alone, since it becomes a stored step reason.
 */
class ReviewerRosterUnread extends Error {
  override readonly name = "ReviewerRosterUnread";

  constructor(cause: ReviewerAskTimedOut, budgetMs: number) {
    super(`ReviewerAskTimedOut (roster unread after ${minutes(budgetMs)})`, { cause });
  }
}

/** A read has no side effect, so a timed-out roster read is asked again every poll until the budget passes. */
export async function whileRosterSlow<T>(timing: PollTiming, signal: AbortSignal, budgetMs: number, read: () => Promise<T>): Promise<T> {
  const startedAt = timing.now();
  for (;;) {
    signal.throwIfAborted();
    try {
      return await read();
    } catch (error) {
      if (!(error instanceof ReviewerAskTimedOut)) throw error;
      if (timing.now() - startedAt >= budgetMs) throw new ReviewerRosterUnread(error, budgetMs);
    }
    await timing.sleep(timing.pollMs, signal);
  }
}

/** Every step's roster read waits out a booting broker and then a slow one, so no step turns a busy broker into a refusal (TP-3020). */
export const patientRoster = <T>(timing: BrokerDownTiming, signal: AbortSignal, budgetMs: number, read: () => Promise<T>): Promise<T> =>
  whileRosterSlow(timing, signal, budgetMs, () => whileBrokerBooting(timing, signal, read));

/** An unread roster started nobody, so the step says so rather than reading as a refusal; any other throw stays one. */
export function rosterUnread(error: unknown): NotStarted {
  if (!(error instanceof ReviewerRosterUnread)) throw error;
  return { kind: "none", reason: `the reviewer dispatch was refused: ${error.message}`, notStarted: true };
}

/** The port throws this when the broker refused a start for a reason that clears with time, such as its machine guard; nobody was started. */
export class ReviewerBrokerBusy extends Error {
  override readonly name: string = "ReviewerBrokerBusy";
}

/** The broker's own failures that clear with time; a permission, missing-file or parse failure reads the same every time. */
const TRANSIENT = [ReviewerAskTimedOut, ReviewerBrokerDown, ReviewerBrokerBusy, DispatchTimeoutError, BrokerUnavailableError];

export const transient = (error: unknown): boolean =>
  TRANSIENT.some((kind) => error instanceof kind) || /^HTTP 5\d\d$/.test(failureOf(error));

/** The broker refused because the machine stop holds; a storm can outlast the busy wait, so the hold has its own, longer ceiling. */
export class ReviewerMachineHold extends ReviewerBrokerBusy {
  override readonly name: string = "ReviewerMachineHold";
}

/** The factory's own spawn gate deferred a start that is not queued, so it asks again after the gate's window rather than a doubling wait. */
export class ReviewerSpawnQueued extends ReviewerMachineHold {
  override readonly name = "ReviewerSpawnQueued";
}

/**
 * The busy wait ran out with the broker still refusing; nobody was started, so the review never began. The message is
 * built here from the refusal's class and the budget alone, since it becomes a stored step reason.
 */
export class ReviewerStillBusy extends Error {
  override readonly name = "ReviewerStillBusy";

  constructor(cause: ReviewerBrokerBusy, budgetMs: number) {
    const why = cause instanceof ReviewerMachineHold ? "still held by the machine stop" : "still refused";
    super(`${errorClass(cause)} (${why} after ${minutes(budgetMs)})`, { cause });
  }
}

/** Every wait a busy broker cost, oldest first; absent when the broker never refused as busy. */
export type BusyWaits = { busyWaits?: string[] };
/** The broker stayed busy past the wait, so no reviewer ran and the review never began. */
export type NotStarted = { kind: "none"; reason: string; notStarted: true } & BusyWaits;

/** What a resync answers a review step whose pull request moved: no reviewer, and the run reads the PR again for its new head. */
type Superseded = { kind: "none"; reason: string };

export const busyWaits = (waits: string[]): BusyWaits => (waits.length > 0 ? { busyWaits: waits } : {});

/**
 * A still-busy broker, or a queued review its pull request moved past, started nobody, so the step says so rather than reading as
 * a review that ran; any other throw stays a refusal.
 */
export function notStarted(error: unknown, waits: string[]): NotStarted | Superseded {
  if (error instanceof ReviewSuperseded && error.moved) return { kind: "none", reason: `superseded: the pull request moved from head ${error.moved.from} to ${error.moved.to}` };
  if (error instanceof ReviewSuperseded) return { kind: "none", reason: `the reviewer dispatch was dropped: ${error.message}`, notStarted: true, ...busyWaits(waits) };
  if (!(error instanceof ReviewerStillBusy)) throw error;
  return { kind: "none", reason: `the reviewer dispatch was refused: ${error.message}`, notStarted: true, ...busyWaits(waits) };
}

/** A timed-out ask whose reviewer never showed up started nobody; the reason is built from the class and the wait alone, since it becomes a stored step reason. */
export function timedOutUnseen(waitedMs: number, waits: string[]): NotStarted {
  const reason = `the reviewer dispatch was refused: ReviewerAskTimedOut (no reviewer seen after ${minutes(waitedMs)})`;
  return { kind: "none", reason, notStarted: true, ...busyWaits(waits) };
}

/** An ask that went through, followed by roster reads that all timed out, left the session unseen; built from the class and the wait alone, since it becomes a stored step reason. */
export function rosterUnreadAfterAsk(waitedMs: number, waits: string[]): NotStarted {
  const reason = `the reviewer dispatch was refused: ReviewerAskTimedOut (roster unread after ${minutes(waitedMs)})`;
  return { kind: "none", reason, notStarted: true, ...busyWaits(waits) };
}

/** The first wait after a busy refusal; each later wait doubles, up to the longest. */
export const BUSY_FIRST_WAIT_MS = 60_000;
export const BUSY_LONGEST_WAIT_MS = 8 * 60_000;
/** One reviewer's own verdict budget: a broker still busy after it is saturated, not briefly full, so the owner hears of it. */
export const DEFAULT_BUSY_WAIT_MS = 30 * 60_000;
/** A machine stop lifts on its own once load settles, so its wait is spent apart from the busy budget, up to this ceiling. */
export const DEFAULT_HOLD_WAIT_MS = 3 * 60 * 60_000;

/** Records what an unread roster waits on, or clears it with undefined once the roster is read. */
export type RosterNote = (text: string | undefined) => void;

/**
 * A roster still unread after a whole budget is read again after a doubling pause, with no cap on rounds. A step that already
 * holds its verdict waits out a slow broker; failing would throw that verdict away and cost a re-register (TP-5086).
 */
export async function untilRosterRead<T>(timing: BrokerDownTiming, signal: AbortSignal, budgetMs: number, read: () => Promise<T>, note?: RosterNote): Promise<T> {
  const startedAt = timing.now();
  let round = 0;
  for (let pause = BUSY_FIRST_WAIT_MS; ; pause = Math.min(pause * 2, BUSY_LONGEST_WAIT_MS)) {
    try {
      const roster = await patientRoster(timing, signal, budgetMs, read);
      note?.(undefined);
      return roster;
    } catch (error) {
      if (!(error instanceof ReviewerRosterUnread)) throw error;
    }
    round += 1;
    note?.(`roster unread after round ${round}; reading again in ${minutes(pause)} (${minutes(timing.now() - startedAt)} waited so far)`);
    await timing.sleep(pause, signal);
  }
}

export interface BusyTiming {
  now: () => number;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  busyWaitMs: number;
}

type BusyKind = "busy" | "hold";

const kindOf = (error: ReviewerBrokerBusy): BusyKind => (error instanceof ReviewerMachineHold ? "hold" : "busy");

/**
 * Asks again after a busy refusal, doubling the wait, until `busyWaitMs` of busy refusals has passed; time held by the machine
 * stop is spent from `DEFAULT_HOLD_WAIT_MS` instead. Each stretch counts against the refusal that began it. `note` names each wait as it starts.
 */
export async function whileBrokerBusy<T>(timing: BusyTiming, signal: AbortSignal, note: (text: string) => void, ask: () => Promise<T>): Promise<T> {
  const budget: Record<BusyKind, number> = { busy: timing.busyWaitMs, hold: DEFAULT_HOLD_WAIT_MS };
  const spent: Record<BusyKind, number> = { busy: 0, hold: 0 };
  let mark = timing.now();
  let waitingOn: BusyKind | undefined;
  for (let wait = BUSY_FIRST_WAIT_MS; ; wait = Math.min(wait * 2, BUSY_LONGEST_WAIT_MS)) {
    try {
      return await ask();
    } catch (error) {
      if (!(error instanceof ReviewerBrokerBusy)) throw error;
      const kind = kindOf(error);
      spent[waitingOn ?? kind] += timing.now() - mark;
      const left = budget[kind] - spent[kind];
      if (left <= 0) throw new ReviewerStillBusy(error, budget[kind]);
      const ms = Math.min(error instanceof ReviewerSpawnQueued ? BUSY_FIRST_WAIT_MS : wait, left);
      note(`${kind === "hold" ? "held by the machine stop: " : ""}${errorClass(error)}; asking again in ${minutes(ms)}`);
      mark = timing.now();
      waitingOn = kind;
      await timing.sleep(ms, signal);
    }
  }
}

/** What a PR's review waits on besides the reviewer, keyed `repo#pr`; in memory, because only the live host's steps can be waiting. */
const waits = new Map<string, string>();

const keyOf = (repo: string, pr: number) => `${repo}#${pr}`;

export function noteReviewWait(repo: string, pr: number, text: string): void {
  waits.set(keyOf(repo, pr), text);
}

export function clearReviewWait(repo: string, pr: number): void {
  waits.delete(keyOf(repo, pr));
}

export function reviewWait(repo: string, pr: number | null): string | undefined {
  return pr === null ? undefined : waits.get(keyOf(repo, pr));
}

/** `onlyTimedOut` means every read failed with a timeout and none answered, so the roster was never seen at all. */
type Started<A> = { agent?: A; rosterError?: string; onlyTimedOut?: true };

async function readRoster<A>(roster: () => Promise<readonly A[]>): Promise<{ agents: readonly A[]; error?: string; timedOut?: true }> {
  try {
    return { agents: await roster() };
  } catch (error) {
    return { agents: [], error: failureOf(error), ...(error instanceof ReviewerAskTimedOut && { timedOut: true as const }) };
  }
}

/**
 * Polls the roster until exactly one agent `holds` and its session has started. Two holders end the wait at once. A failed
 * read is retried until the deadline, and the last failure is kept so a timeout can say why the agent was never seen.
 */
export async function startedSession<A extends { sessionId: string }>(roster: () => Promise<readonly A[]>, holds: (agent: A) => boolean, timing: DeadlineTiming & { pollMs: number }, signal: AbortSignal): Promise<Started<A>> {
  const clock = deadline(timing);
  let rosterError: string | undefined;
  let answered = false;
  let failedOtherwise = false;
  for (;;) {
    const read = await readRoster(roster);
    rosterError = read.error ?? rosterError;
    answered ||= read.error === undefined;
    failedOtherwise ||= read.error !== undefined && !read.timedOut;
    const found = read.agents.filter(holds);
    if (found.length > 1) return {};
    if (found[0] && found[0].sessionId !== "") return { agent: found[0] };
    if (clock.expired()) return rosterError === undefined ? {} : { rosterError, ...(!answered && !failedOtherwise && { onlyTimedOut: true as const }) };
    await clock.sleep(timing.pollMs, signal);
  }
}
