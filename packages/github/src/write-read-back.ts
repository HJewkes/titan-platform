import { isRetryableWrite } from "./update-branch-retry.js";

export type Sleep = (ms: number) => Promise<void>;
export const pause: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits before each read-back; one retry of the write sits between them, so a persistent failure surfaces after about four seconds. */
const WRITE_READ_BACK_DELAYS_MS = [1000, 3000];

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
    const status = (last as { status?: unknown } | null)?.status;
    this.status = typeof status === "number" ? status : undefined;
  }
}

/**
 * A 5xx or an unreadable answer may hide a write that landed, so each one is followed by a read-back that counts a
 * landed write as done; only a write the read-back cannot see is sent again. A 4xx is final.
 */
export async function writeWithReadBack<R>(step: string, write: () => Promise<R>, landed: () => Promise<R | undefined>, sleep: Sleep): Promise<R> {
  let last: unknown;
  for (const delay of WRITE_READ_BACK_DELAYS_MS) {
    try {
      return await write();
    } catch (error) {
      if (!isRetryableWrite(error)) throw error;
      last = error;
    }
    await sleep(delay);
    const done = await landed().catch(() => undefined);
    if (done !== undefined) return done;
  }
  throw new WriteRetriesExhaustedError(step, WRITE_READ_BACK_DELAYS_MS.length, last);
}
