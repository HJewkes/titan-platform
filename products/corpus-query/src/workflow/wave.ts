import { mapItems, type MapItemFn, type MapResult, type WorkflowContext } from "@titan-design/workflow";

export interface WaveOptions<T> {
  key: (item: T) => string;
  concurrency: number;
  /** What the run may still spend; passed to both fan-outs. */
  budgetUsd: number;
}

export interface WaveResult<T> {
  spentUsd: number;
  skipped: T[];
  failed: T[];
  stoppedBy: MapResult<T>["stoppedBy"];
}

/**
 * One item alone first, then the rest at the cap. A cache write is readable only once its call has completed, so
 * the warm call pays the prefix write and every later call of the wave reads it.
 */
export async function warmThenWave<T>(ctx: WorkflowContext, stepId: string, items: readonly T[], fn: MapItemFn<T>, options: WaveOptions<T>): Promise<WaveResult<T>> {
  if (items.length === 0) return { spentUsd: 0, skipped: [], failed: [], stoppedBy: null };
  const warm = await mapItems(ctx, `${stepId}/warm`, items.slice(0, 1), fn, { key: options.key, concurrency: 1, budgetUsd: options.budgetUsd });
  const rest = warm.stoppedBy
    ? { results: [], failed: [], skipped: items.slice(1).map((item) => ({ key: options.key(item), item })), spentUsd: 0, stoppedBy: warm.stoppedBy }
    : await mapItems(ctx, stepId, items.slice(1), fn, { key: options.key, concurrency: options.concurrency, budgetUsd: options.budgetUsd - warm.spentUsd });
  return {
    spentUsd: warm.spentUsd + rest.spentUsd,
    skipped: [...warm.skipped, ...rest.skipped].map((s) => s.item),
    failed: [...warm.failed, ...rest.failed].map((f) => f.item),
    stoppedBy: warm.stoppedBy ?? rest.stoppedBy,
  };
}
