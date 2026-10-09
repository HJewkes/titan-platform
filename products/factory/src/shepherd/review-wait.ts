import { deadline, type DeadlineTiming } from "../workflows/deadline.js";
import { errorClass, failureOf } from "./error-class.js";

const minutes = (ms: number) => `${Math.round(ms / 6_000) / 10} min`;

/** The port throws this when the broker cannot be reached: nothing was asked of it, so asking again is safe. */
export class ReviewerBrokerDown extends Error {
  override readonly name = "ReviewerBrokerDown";
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

/** The port throws this when the broker refused a start for a reason that clears with time, such as its machine guard; nobody was started. */
export class ReviewerBrokerBusy extends Error {
  override readonly name: string = "ReviewerBrokerBusy";
}

/** The broker refused because the machine stop holds; a storm can outlast the busy wait, so the hold has its own, longer ceiling. */
export class ReviewerMachineHold extends ReviewerBrokerBusy {
  override readonly name = "ReviewerMachineHold";
}

/** The factory's own spawn gate deferred the start; it admits oldest-first, so the queue's head must ask again within a window or the opening is lost. */
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

export const busyWaits = (waits: string[]): BusyWaits => (waits.length > 0 ? { busyWaits: waits } : {});

/** A still-busy broker started nobody, so the step says so rather than reading as a review that ran; any other throw stays a refusal. */
export function notStarted(error: unknown, waits: string[]): NotStarted {
  if (!(error instanceof ReviewerStillBusy)) throw error;
  return { kind: "none", reason: `the reviewer dispatch was refused: ${error.message}`, notStarted: true, ...busyWaits(waits) };
}

/** The first wait after a busy refusal; each later wait doubles, up to the longest. */
export const BUSY_FIRST_WAIT_MS = 60_000;
export const BUSY_LONGEST_WAIT_MS = 8 * 60_000;
/** One reviewer's own verdict budget: a broker still busy after it is saturated, not briefly full, so the owner hears of it. */
export const DEFAULT_BUSY_WAIT_MS = 30 * 60_000;
/** A machine stop lifts on its own once load settles, so its wait is spent apart from the busy budget, up to this ceiling. */
export const DEFAULT_HOLD_WAIT_MS = 3 * 60 * 60_000;

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

type Started<A> = { agent?: A; rosterError?: string };

async function readRoster<A>(roster: () => Promise<readonly A[]>): Promise<{ agents: readonly A[]; error?: string }> {
  try {
    return { agents: await roster() };
  } catch (error) {
    return { agents: [], error: failureOf(error) };
  }
}

/**
 * Polls the roster until exactly one agent `holds` and its session has started. Two holders end the wait at once. A failed
 * read is retried until the deadline, and the last failure is kept so a timeout can say why the agent was never seen.
 */
export async function startedSession<A extends { sessionId: string }>(roster: () => Promise<readonly A[]>, holds: (agent: A) => boolean, timing: DeadlineTiming & { pollMs: number }, signal: AbortSignal): Promise<Started<A>> {
  const clock = deadline(timing);
  let rosterError: string | undefined;
  for (;;) {
    const read = await readRoster(roster);
    rosterError = read.error ?? rosterError;
    const found = read.agents.filter(holds);
    if (found.length > 1) return {};
    if (found[0] && found[0].sessionId !== "") return { agent: found[0] };
    if (clock.expired()) return rosterError === undefined ? {} : { rosterError };
    await clock.sleep(timing.pollMs, signal);
  }
}
