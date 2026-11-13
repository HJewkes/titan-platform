import { classifyGitHubFailure, parseRateLimitMarker } from "@titan-design/github";
import type { RoutedStepInput, StepRoute, StepRunOutcome } from "@titan-design/workflow";
import { recordedFailureClass, type FailureClass } from "./failure-class.js";

/** Waits before each retry, so a step is tried once and then up to this many more times. */
const GH_RETRY_BACKOFF_MS: readonly number[] = [5_000, 20_000, 60_000];

/** A limit outlasting two waits is not a blip; the run fails as it did before, now filed gh-rate-limit. */
const RATE_LIMIT_WAITS = 2;
/** `x-ratelimit-reset` is GitHub's clock, in whole seconds, so the re-read lands a little after it. */
const RESET_MARGIN_MS = 5_000;
const MAX_RATE_LIMIT_WAIT_MS = 61 * 60_000;
/** A write may have landed before GitHub refused the next call, so only a refused read is read again. */
const READ_METHODS = new Set(["GET", "HEAD"]);

interface GhRetryTiming {
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  backoffMs?: readonly number[];
  now?: () => number;
}

interface Retried {
  attempt: number;
  class: FailureClass;
  waitMs: number;
  error: string;
}


/** The retries ride on the evidence record the step already writes, so the run's step results show them. */
function withRetries(output: string, retries: readonly Retried[]): string {
  if (retries.length === 0) return output;
  try {
    const record: unknown = JSON.parse(output);
    if (typeof record !== "object" || record === null || Array.isArray(record)) return output;
    return JSON.stringify({ ...record, ghRetries: retries });
  } catch {
    return output;
  }
}

/** Until the limit's reset as the transport's marker gives it: retry-after, else x-ratelimit-reset plus a margin, else 60 s. */
export function rateLimitWaitMs(error: string, now: number): number | undefined {
  const facts = parseRateLimitMarker(error);
  if (!facts || !READ_METHODS.has(facts.method)) return undefined;
  const failure = classifyGitHubFailure({ ...facts, message: error, streak: 0, now });
  if (failure.kind !== "unavailable") return undefined;
  const margin = failure.source === "x-ratelimit-reset" ? RESET_MARGIN_MS : 0;
  return Math.min(Math.max(failure.resetAt + margin - now, 0), MAX_RATE_LIMIT_WAIT_MS);
}

function waitFor(failureClass: FailureClass, error: string, done: number, timing: GhRetryTiming): number | undefined {
  if (failureClass === "gh-api-5xx") return (timing.backoffMs ?? GH_RETRY_BACKOFF_MS)[done];
  if (failureClass === "gh-rate-limit" && done < RATE_LIMIT_WAITS) return rateLimitWaitMs(error, (timing.now ?? Date.now)());
  return undefined;
}

/** Every route this wraps is a code route that records the class where its body failed, so the outcome's field decides. */
function nextRetry(outcome: StepRunOutcome & { ok: false }, retries: readonly Retried[], timing: GhRetryTiming): Retried | undefined {
  const { error } = outcome;
  const failureClass = recordedFailureClass(outcome.errorClass);
  const waitMs = waitFor(failureClass, error, retries.filter((retry) => retry.class === failureClass).length, timing);
  return waitMs === undefined ? undefined : { attempt: retries.length + 1, class: failureClass, waitMs, error };
}

function exhausted(outcome: StepRunOutcome & { ok: false }, retries: readonly Retried[]): StepRunOutcome {
  if (retries.length === 0) return outcome;
  const counts = new Map<FailureClass, number>();
  for (const retry of retries) counts.set(retry.class, (counts.get(retry.class) ?? 0) + 1);
  const summary = [...counts].map(([failureClass, count]) => `${count} ${failureClass} retries`).join(", ");
  return { ...outcome, error: `${outcome.error} (after ${summary})` };
}

async function runRetrying(route: StepRoute, input: RoutedStepInput, timing: GhRetryTiming): Promise<StepRunOutcome> {
  const retries: Retried[] = [];
  for (;;) {
    const outcome = await route.runner.run(input);
    if (outcome.ok) return { ...outcome, output: withRetries(outcome.output, retries) };
    const retry = nextRetry(outcome, retries, timing);
    if (!retry) return exhausted(outcome, retries);
    retries.push(retry);
    await timing.sleep(retry.waitMs, input.signal);
  }
}

/**
 * Retries a repeat-safe route whose failure is a GitHub server-side error, with a bounded backoff, or a rate limit on
 * a read, after the limit resets; any other class fails at once. A `park` route may have written before it failed, so
 * it is left alone.
 */
export function retryingGhServerErrors(routes: readonly StepRoute[], timing: GhRetryTiming): StepRoute[] {
  return routes.map((route) => (route.onRestart === "repeat" ? { ...route, runner: { run: (input) => runRetrying(route, input, timing) } } : route));
}
