import { httpStatusOf, isRetryableWrite } from "./rest.js";

export type Sleep = (ms: number) => Promise<void>;
export const pause: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits before each read-back; one retry of the write sits between them, so a persistent failure surfaces after about four seconds. */
const WRITE_READ_BACK_DELAYS_MS = [1000, 3000];

export interface RetrySchedule {
  /** The wait before the read-back that follows failed write `i`; a 0 reads back at once without sleeping. */
  readonly delays: readonly number[];
  /** Writes sent at most; one per delay by default, so the last failure is read back too. */
  readonly attempts?: number;
  /** Throws the last write's own error rather than WriteRetriesExhaustedError, for writes whose callers already classify it. */
  readonly rawError?: boolean;
}

const MERGE_SCHEDULE: RetrySchedule = { delays: WRITE_READ_BACK_DELAYS_MS };

/** A write that kept answering a 5xx or an unreadable answer; `status` is the last answer's, so callers still classify it. */
export class WriteRetriesExhaustedError extends Error {
  readonly status: number | undefined;

  constructor(
    readonly step: string,
    attempts: number,
    readonly last: unknown,
  ) {
    super(`${step} failed after ${attempts} attempts: ${last instanceof Error ? last.message : String(last)}`, { cause: last });
    this.name = "WriteRetriesExhaustedError";
    this.status = httpStatusOf(last);
  }
}

/**
 * A 5xx or an unreadable answer may hide a write that landed, so each one is followed by a read-back that counts a
 * landed write as done; only a write the read-back cannot see is sent again. A 4xx is final.
 */
export async function writeWithReadBack<R>(step: string, write: () => Promise<R>, landed: () => Promise<R | undefined>, sleep: Sleep, schedule: RetrySchedule = MERGE_SCHEDULE): Promise<R> {
  const attempts = schedule.attempts ?? schedule.delays.length;
  let last: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await write();
    } catch (error) {
      if (!isRetryableWrite(error)) throw error;
      last = error;
    }
    const delay = schedule.delays[attempt];
    if (delay === undefined) break;
    if (delay > 0) await sleep(delay);
    const done = await landed().catch(() => undefined);
    if (done !== undefined) return done;
  }
  throw schedule.rawError ? last : new WriteRetriesExhaustedError(step, attempts, last);
}
