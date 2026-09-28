import { StepFailedError, type StepResult, type StepUsage, type WorkflowContext } from "./types.js";

const DEFAULT_MAX_FAILURES = 3;

export interface MapOptions<T> {
  /** Stable identity per item. Resume matches finished items by key, so reordering the input is safe. */
  key: (item: T) => string;
  /** Items in flight at once. Defaults to 1. */
  concurrency?: number;
  /**
   * Stop launching items once finished items have spent this much. In-flight
   * items are not counted, so a run can overshoot by up to `concurrency - 1` items.
   */
  budgetUsd?: number;
  /** Retryable item failures tolerated before launches stop. Defaults to 3. A non-retryable failure always stops launches. */
  maxFailures?: number;
}

/** Runs one item. Pass `itemStepId` to `ctx.dispatch` so each item memoizes on its own. */
export type MapItemFn<T> = (item: T, itemStepId: string, ctx: WorkflowContext) => Promise<StepResult>;

export interface MapItemResult<T> {
  key: string;
  item: T;
  result: StepResult;
}

export interface MapItemFailure<T> {
  key: string;
  item: T;
  error: string;
  retryable: boolean;
  /** Cost of the item's failed attempts, when the runner reported it; already counted in `spentUsd`. */
  usage?: StepUsage;
}

export interface MapResult<T> {
  /** In input order. */
  results: MapItemResult<T>[];
  failed: MapItemFailure<T>[];
  /** Items never launched because the budget ran out or failures stopped the run. */
  skipped: { key: string; item: T }[];
  /** Cost reported by finished and failed items. */
  spentUsd: number;
  stoppedBy: "budget" | "failure" | null;
}

interface Keyed<T> {
  key: string;
  item: T;
}

interface FanOutState<T> {
  next: number;
  spentUsd: number;
  stoppedBy: MapResult<T>["stoppedBy"];
  results: Map<string, StepResult>;
  failed: MapItemFailure<T>[];
  error?: unknown;
}

/**
 * Run `fn` over `items` with a concurrency cap and a budget cap. Each item runs
 * as step `${stepId}/${key}`, so a replay after restart reuses finished items
 * and runs only the rest. A `StepFailedError` is recorded in `failed`; a
 * non-retryable one, or one past `maxFailures`, stops new launches. Any other
 * error is rethrown once in-flight items settle.
 */
export async function mapItems<T>(
  ctx: WorkflowContext,
  stepId: string,
  items: readonly T[],
  fn: MapItemFn<T>,
  options: MapOptions<T>,
): Promise<MapResult<T>> {
  const keyed = keyItems(items, options.key);
  const state: FanOutState<T> = { next: 0, spentUsd: 0, stoppedBy: null, results: new Map(), failed: [] };
  const lanes = Math.min(Math.max(1, options.concurrency ?? 1), keyed.length);
  await Promise.all(Array.from({ length: lanes }, () => runLane(ctx, stepId, keyed, fn, options, state)));
  if (state.error !== undefined) throw state.error;
  return summarize(keyed, state);
}

async function runLane<T>(
  ctx: WorkflowContext,
  stepId: string,
  keyed: Keyed<T>[],
  fn: MapItemFn<T>,
  options: MapOptions<T>,
  state: FanOutState<T>,
): Promise<void> {
  while (state.next < keyed.length && state.stoppedBy === null && state.error === undefined) {
    if (options.budgetUsd !== undefined && state.spentUsd >= options.budgetUsd) {
      state.stoppedBy = "budget";
      return;
    }
    const entry = keyed[state.next++]!;
    try {
      const result = await fn(entry.item, `${stepId}/${entry.key}`, ctx);
      state.spentUsd += result.usage?.costUsd ?? 0;
      state.results.set(entry.key, result);
    } catch (error) {
      if (error instanceof StepFailedError) recordFailure(entry, error, options, state);
      else state.error ??= error;
    }
  }
}

function recordFailure<T>(entry: Keyed<T>, error: StepFailedError, options: MapOptions<T>, state: FanOutState<T>): void {
  state.failed.push({ ...entry, error: error.reason, retryable: error.retryable, ...(error.usage ? { usage: error.usage } : {}) });
  state.spentUsd += error.usage?.costUsd ?? 0;
  const tooMany = state.failed.length > (options.maxFailures ?? DEFAULT_MAX_FAILURES);
  if (!error.retryable || tooMany) state.stoppedBy ??= "failure";
}

function keyItems<T>(items: readonly T[], key: (item: T) => string): Keyed<T>[] {
  const seen = new Set<string>();
  return items.map((item) => {
    const itemKey = key(item);
    if (seen.has(itemKey)) throw new Error(`mapItems: duplicate item key "${itemKey}"`);
    seen.add(itemKey);
    return { key: itemKey, item };
  });
}

function summarize<T>(keyed: Keyed<T>[], state: FanOutState<T>): MapResult<T> {
  const failedKeys = new Set(state.failed.map((failure) => failure.key));
  const results: MapItemResult<T>[] = [];
  const skipped: Keyed<T>[] = [];
  for (const entry of keyed) {
    const result = state.results.get(entry.key);
    if (result) results.push({ ...entry, result });
    else if (!failedKeys.has(entry.key)) skipped.push(entry);
  }
  return { results, failed: state.failed, skipped, spentUsd: state.spentUsd, stoppedBy: state.stoppedBy };
}
