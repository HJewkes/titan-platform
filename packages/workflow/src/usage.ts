import { foldUsage, type UsageMeasurement } from "@titan-design/agent-protocol";
import type { StepUsage } from "./types.js";

export function addUsage(total: StepUsage | undefined, next: StepUsage | undefined): StepUsage | undefined {
  if (!next) return total;
  if (!total) return next;
  const tokens = (a?: number, b?: number) => (a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0));
  const inputTokens = tokens(total.inputTokens, next.inputTokens);
  const outputTokens = tokens(total.outputTokens, next.outputTokens);
  return {
    costUsd: total.costUsd + next.costUsd,
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
  };
}

/** Sums a harness's measurements; an unpriced measurement adds its tokens and no cost. */
export function usageFromMeasurements(measurements: readonly UsageMeasurement[]): StepUsage | undefined {
  return foldUsage(measurements).measurements.reduce<StepUsage | undefined>((total, measurement) => addUsage(total, {
    costUsd: measurement.cost?.usd ?? 0,
    ...(measurement.tokens.input === null ? {} : { inputTokens: measurement.tokens.input }),
    ...(measurement.tokens.output === null ? {} : { outputTokens: measurement.tokens.output }),
  }), undefined);
}
