import { foldUsage, type TokenCounts, type UsageMeasurement } from "@titan-design/agent-protocol";

export interface SessionUsageSummary {
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  requestCount: number | null;
  tokens: TokenCounts;
  basis: "delta" | "snapshot";
}

/** Collects one conversation's measurements; the shared fold decides which of them count. */
export class SessionUsageAccumulator {
  private readonly measurements: UsageMeasurement[] = [];

  add(measurement: UsageMeasurement): void {
    this.measurements.push(measurement);
  }

  summaries(): SessionUsageSummary[] {
    const { basis, measurements } = foldUsage(this.measurements);
    return aggregate(basis === "delta" ? measurements
      : measurements.map(value => value.kind === "snapshot" && value.scope === "conversation" ? { ...value, model: null } : value), basis);
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
