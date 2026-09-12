import type { TokenCounts, UsageMeasurement } from "@titan-design/agent-protocol";

export interface SessionUsageSummary {
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  requestCount: number | null;
  tokens: TokenCounts;
  basis: "delta" | "snapshot";
}

/** Fold one conversation: response deltas supersede snapshots; reset epochs remain independently accounted. */
export class SessionUsageAccumulator {
  private readonly deltas = new Map<string, Extract<UsageMeasurement, { kind: "delta" }>>();
  private readonly snapshots = new Map<string, Extract<UsageMeasurement, { kind: "snapshot" }>>();

  add(measurement: UsageMeasurement): void {
    if (measurement.kind === "delta") {
      this.deltas.set(measurement.responseId, measurement);
      return;
    }
    const key = JSON.stringify([measurement.scope, measurement.scopeId, measurement.epoch]);
    const previous = this.snapshots.get(key);
    if (!previous || previous.sequence <= measurement.sequence) this.snapshots.set(key, measurement);
  }

  summaries(): SessionUsageSummary[] {
    if (this.deltas.size) return aggregate([...this.deltas.values()], "delta");
    const snapshots = [...this.snapshots.values()];
    const conversationEpochs = new Set(snapshots.filter(value => value.scope === "conversation").map(value => value.epoch));
    const values = snapshots.filter(value => value.scope === "conversation" || !conversationEpochs.has(value.epoch))
      .map(value => value.scope === "conversation" ? { ...value, model: null } : value);
    return aggregate(values, "snapshot");
  }
}

function aggregate(values: UsageMeasurement[], basis: "delta" | "snapshot"): SessionUsageSummary[] {
  const groups = new Map<string | null, UsageMeasurement[]>();
  for (const value of values) {
    const group = groups.get(value.model) ?? [];
    group.push(value);
    groups.set(value.model, group);
  }
  return [...groups].map(([model, group]) => {
    const sum = (key: keyof TokenCounts) => group.some(value => value.tokens[key] === null)
      ? null : group.reduce((total, value) => total + value.tokens[key]!, 0);
    const tokens = { input: sum("input"), output: sum("output"), cachedInput: sum("cachedInput"),
      cacheWriteInput: sum("cacheWriteInput"), reasoningOutput: sum("reasoningOutput"), total: sum("total") };
    return { model, inputTokens: tokens.input, outputTokens: tokens.output,
      requestCount: basis === "delta" ? group.length : null, tokens, basis };
  });
}
