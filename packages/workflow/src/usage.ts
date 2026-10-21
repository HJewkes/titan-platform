import { foldUsage, type UsageMeasurement } from "@titan-design/agent-protocol";
import type { StepUsage } from "./types.js";

export function addUsage(total: StepUsage | undefined, next: StepUsage | undefined): StepUsage | undefined {
  if (!next) return total;
  if (!total) return next;
  const tokens = (a?: number, b?: number) => (a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0));
  const inputTokens = tokens(total.inputTokens, next.inputTokens);
  const outputTokens = tokens(total.outputTokens, next.outputTokens);
  const cacheReadTokens = tokens(total.cacheReadTokens, next.cacheReadTokens);
  const cacheWrite5mTokens = tokens(total.cacheWrite5mTokens, next.cacheWrite5mTokens);
  const cacheWrite1hTokens = tokens(total.cacheWrite1hTokens, next.cacheWrite1hTokens);
  const model = total.model !== undefined && total.model === next.model ? total.model : undefined;
  return {
    costUsd: total.costUsd + next.costUsd,
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(cacheWrite5mTokens === undefined ? {} : { cacheWrite5mTokens }),
    ...(cacheWrite1hTokens === undefined ? {} : { cacheWrite1hTokens }),
    ...(model === undefined ? {} : { model }),
    ...(total.costUnknown || next.costUnknown ? { costUnknown: true as const } : {}),
  };
}

/** Sums a harness's measurements; an unpriced measurement adds its tokens and marks the sum `costUnknown`. */
export function usageFromMeasurements(measurements: readonly UsageMeasurement[]): StepUsage | undefined {
  return foldUsage(measurements).measurements.reduce<StepUsage | undefined>((total, measurement) => addUsage(total, {
    costUsd: measurement.cost?.usd ?? 0,
    ...(measurement.tokens.input === null ? {} : { inputTokens: measurement.tokens.input }),
    ...(measurement.tokens.output === null ? {} : { outputTokens: measurement.tokens.output }),
    ...(measurement.tokens.cachedInput === null ? {} : { cacheReadTokens: measurement.tokens.cachedInput }),
    ...(measurement.cost === null ? { costUnknown: true as const } : {}),
  }), undefined);
}
