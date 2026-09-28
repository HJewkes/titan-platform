import type { DurableHarnessSuccess } from "@titan-design/agent";
import type { StepUsage } from "./types.js";

type UsageMeasurement = DurableHarnessSuccess["usage"][number];

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
  return latestMeasurements(measurements).reduce<StepUsage | undefined>((total, measurement) => addUsage(total, {
    costUsd: measurement.cost?.usd ?? 0,
    ...(measurement.tokens.input === null ? {} : { inputTokens: measurement.tokens.input }),
    ...(measurement.tokens.output === null ? {} : { outputTokens: measurement.tokens.output }),
  }), undefined);
}

/** Deltas deduplicate by response id; a later snapshot replaces an earlier one for the same scope and epoch. */
function latestMeasurements(measurements: readonly UsageMeasurement[]): UsageMeasurement[] {
  const byIdentity = new Map<string, UsageMeasurement>();
  for (const measurement of measurements) {
    const identity = measurement.kind === "delta"
      ? `delta:${measurement.responseId}`
      : `snapshot:${measurement.scope}:${measurement.scopeId}:${measurement.epoch}`;
    const held = byIdentity.get(identity);
    if (held?.kind === "snapshot" && measurement.kind === "snapshot" && held.sequence > measurement.sequence) continue;
    if (held?.kind === "delta") continue;
    byIdentity.set(identity, measurement);
  }
  return [...byIdentity.values()];
}
