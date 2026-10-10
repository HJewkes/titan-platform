import type { RoutedStepInput, StepRoute, StepRunOutcome } from "@titan-design/workflow";
import { failureClassOf } from "./failure-class.js";

/** Waits before each retry, so a step is tried once and then up to this many more times. */
export const GH_RETRY_BACKOFF_MS: readonly number[] = [5_000, 20_000, 60_000];

export interface GhRetryTiming {
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  backoffMs?: readonly number[];
}

interface Retried {
  attempt: number;
  waitMs: number;
  error: string;
}

/** The text the workflow context files a failed step under, which is what `failureClassOf` reads the step name from. */
function classOf(input: RoutedStepInput, error: string) {
  return failureClassOf(`step ${input.stepId} (iteration ${input.iteration}) failed: ${error}`);
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

async function runRetrying(route: StepRoute, input: RoutedStepInput, timing: GhRetryTiming): Promise<StepRunOutcome> {
  const backoff = timing.backoffMs ?? GH_RETRY_BACKOFF_MS;
  const retries: Retried[] = [];
  for (;;) {
    const outcome = await route.runner.run(input);
    if (outcome.ok) return { ...outcome, output: withRetries(outcome.output, retries) };
    const waitMs = backoff[retries.length];
    if (waitMs === undefined || classOf(input, outcome.error) !== "gh-api-5xx") {
      return retries.length === 0 ? outcome : { ...outcome, error: `${outcome.error} (after ${retries.length} gh-api-5xx retries)` };
    }
    retries.push({ attempt: retries.length + 1, waitMs, error: outcome.error });
    await timing.sleep(waitMs, input.signal);
  }
}

/**
 * Retries a repeat-safe route whose failure is a GitHub server-side error, with a bounded backoff; any other class
 * fails at once. A `park` route may have written before it failed, so it is left alone.
 */
export function retryingGhServerErrors(routes: readonly StepRoute[], timing: GhRetryTiming): StepRoute[] {
  return routes.map((route) => (route.onRestart === "repeat" ? { ...route, runner: { run: (input) => runRetrying(route, input, timing) } } : route));
}
