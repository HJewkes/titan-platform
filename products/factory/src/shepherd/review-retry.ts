import { classifyGitHubFailure, parseRateLimitMarker } from "@titan-design/github";
import { errorStatus } from "../narrow.js";
import { consoleTextOf } from "./error-class.js";

/** Waits before each retry, so a review call is tried once and then up to this many more times. */
const REVIEW_RETRY_BACKOFF_MS: readonly number[] = [1_000, 4_000];
/** A limit that resets later than this outlasts the step; it is recorded, and the next publish tries again. */
const MAX_LIMIT_WAIT_MS = 15_000;

export interface ReviewRetryTiming {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

/**
 * Runs `call`, retrying a GitHub server error or rate limit after a short wait; any other failure, or one that outlasts
 * the retries, is thrown. Only calls safe to repeat come here: a list, or a dismissal, which leaves the review dismissed
 * however often it lands.
 */
export async function withReviewRetry<T>(call: () => Promise<T>, timing: ReviewRetryTiming): Promise<T> {
  for (const backoff of REVIEW_RETRY_BACKOFF_MS) {
    try {
      return await call();
    } catch (error) {
      const wait = transientWaitMs(error, backoff, timing.now());
      if (wait === undefined) throw error;
      await timing.sleep(wait);
    }
  }
  return call();
}

/** How long to wait before retrying, or undefined for a refusal: a 403 or 422 counts as transient only when it names a limit. */
export function transientWaitMs(error: unknown, backoff: number, now: number): number | undefined {
  const status = errorStatus(error);
  if (typeof status === "number" && status >= 500 && status <= 599) return backoff;
  const text = consoleTextOf(error);
  const facts = parseRateLimitMarker(text);
  if (!facts) return undefined;
  const failure = classifyGitHubFailure({ ...facts, message: text, streak: 0, now });
  if (failure.kind !== "unavailable") return undefined;
  const wait = failure.source === "backoff" ? backoff : Math.max(failure.resetAt - now, backoff);
  return wait <= MAX_LIMIT_WAIT_MS ? wait : undefined;
}
