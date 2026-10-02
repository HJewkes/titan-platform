/** The port throws this when the broker refused a start for a reason that clears with time, such as its machine guard; nobody was started. */
export class ReviewerBrokerBusy extends Error {
  override readonly name = "ReviewerBrokerBusy";
}

/** The busy wait ran out with the broker still refusing; nobody was started, so the review never began. */
export class ReviewerStillBusy extends Error {
  override readonly name = "ReviewerStillBusy";
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

export interface BusyTiming {
  now: () => number;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  busyWaitMs: number;
}

const minutes = (ms: number) => `${Math.round(ms / 6_000) / 10} min`;

/** Asks again after a busy refusal, doubling the wait, until `busyWaitMs` has passed; `note` names each wait as it starts. */
export async function whileBrokerBusy<T>(timing: BusyTiming, signal: AbortSignal, note: (text: string) => void, ask: () => Promise<T>): Promise<T> {
  const until = timing.now() + timing.busyWaitMs;
  for (let wait = BUSY_FIRST_WAIT_MS; ; wait = Math.min(wait * 2, BUSY_LONGEST_WAIT_MS)) {
    try {
      return await ask();
    } catch (error) {
      if (!(error instanceof ReviewerBrokerBusy)) throw error;
      const left = until - timing.now();
      if (left <= 0) throw new ReviewerStillBusy(`${error.message} (still refused after ${minutes(timing.busyWaitMs)})`, { cause: error });
      const ms = Math.min(wait, left);
      note(`${error.message}; asking again in ${minutes(ms)}`);
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
