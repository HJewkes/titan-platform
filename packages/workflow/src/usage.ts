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

type Delta = Extract<UsageMeasurement, { kind: "delta" }>;
type Snapshot = Extract<UsageMeasurement, { kind: "snapshot" }>;

/** Same fold as session-read's SessionUsageAccumulator: deltas supersede snapshots, which describe the same spend. */
function latestMeasurements(measurements: readonly UsageMeasurement[]): UsageMeasurement[] {
  const deltas = new Map<string, Delta>();
  const snapshots = new Map<string, Snapshot>();
  for (const measurement of measurements) {
    if (measurement.kind === "delta") {
      deltas.set(measurement.responseId, measurement);
      continue;
    }
    const key = JSON.stringify([measurement.scope, measurement.scopeId, measurement.epoch]);
    const held = snapshots.get(key);
    if (!held || held.sequence <= measurement.sequence) snapshots.set(key, measurement);
  }
  return deltas.size > 0 ? [...deltas.values()] : withoutSupersededScopes([...snapshots.values()]);
}

/** A conversation snapshot already covers every turn in its epoch. */
function withoutSupersededScopes(snapshots: Snapshot[]): Snapshot[] {
  const conversationEpochs = new Set(snapshots.filter((value) => value.scope === "conversation").map((value) => value.epoch));
  return snapshots.filter((value) => value.scope === "conversation" || !conversationEpochs.has(value.epoch));
}
