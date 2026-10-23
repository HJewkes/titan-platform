import { PRICE_TABLE_VERSION, priceRequest } from "@titan-design/agent-protocol/pricing";

/** The $19.10 notional cost of the seven-agent Opus run this product replaces. */
export const BASELINE_USD = 19.1;

/**
 * One model call as the run records it in `runs/<runId>/cost.json`. The cache fields mirror the
 * workflow's `StepUsage` and are absent when the runner did not report them.
 */
export interface UsageEntry {
  stage: string;
  model: string;
  inputTokens?: number;
  cacheReadTokens?: number;
  cacheWrite5mTokens?: number;
  cacheWrite1hTokens?: number;
  outputTokens?: number;
  /** What the CLI itself reported, for the cross-check. */
  cliCostUsd?: number;
}

export interface CostLine {
  stage: string;
  model: string;
  calls: number;
  inputTokens?: number;
  cacheReadTokens?: number;
  cacheWrite5mTokens?: number;
  cacheWrite1hTokens?: number;
  outputTokens?: number;
  usd: number;
}

export interface CostReport {
  lines: CostLine[];
  totalUsd: number;
  baselineUsd?: number;
  baselineRatio?: number;
  hasCacheTokens: boolean;
  unpricedModels: string[];
  cliGapExceeds1Pct: boolean;
}

export interface FoldOptions {
  /** Timestamp the price table is read at. */
  asOf: string;
  baselineUsd?: number;
}

const TOKEN_FIELDS = ["inputTokens", "cacheReadTokens", "cacheWrite5mTokens", "cacheWrite1hTokens", "outputTokens"] as const;

function sumOptional(a: number | undefined, b: number | undefined): number | undefined {
  return a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);
}

function priceEntry(e: UsageEntry, asOf: string) {
  return priceRequest(
    {
      inputTokens: e.inputTokens,
      cacheReadTokens: e.cacheReadTokens,
      cacheCreation5mTokens: e.cacheWrite5mTokens,
      cacheCreation1hTokens: e.cacheWrite1hTokens,
      outputTokens: e.outputTokens,
    },
    e.model,
    asOf,
  );
}

function foldLines(entries: UsageEntry[], asOf: string): { lines: CostLine[]; unpriced: Set<string> } {
  const byKey = new Map<string, CostLine>();
  const unpriced = new Set<string>();
  for (const e of entries) {
    const priced = priceEntry(e, asOf);
    if (!priced.priced) unpriced.add(e.model);
    const key = `${e.stage}\u0000${e.model}`;
    const line = byKey.get(key) ?? { stage: e.stage, model: e.model, calls: 0, usd: 0 };
    line.calls += 1;
    line.usd += priced.costUsd;
    for (const f of TOKEN_FIELDS) {
      const sum = sumOptional(line[f], e[f]);
      if (sum !== undefined) line[f] = sum;
    }
    byKey.set(key, line);
  }
  return { lines: [...byKey.values()], unpriced };
}

export function foldCost(entries: UsageEntry[], options: FoldOptions): CostReport {
  const { lines, unpriced } = foldLines(entries, options.asOf);
  const totalUsd = lines.reduce((sum, l) => sum + l.usd, 0);
  const cliUsd = entries.reduce((sum, e) => sum + (e.cliCostUsd ?? 0), 0);
  const cliReported = entries.some((e) => e.cliCostUsd !== undefined);
  return {
    lines,
    totalUsd,
    baselineUsd: options.baselineUsd,
    baselineRatio: options.baselineUsd ? totalUsd / options.baselineUsd : undefined,
    hasCacheTokens: lines.some((l) => l.cacheReadTokens !== undefined || l.cacheWrite5mTokens !== undefined || l.cacheWrite1hTokens !== undefined),
    unpricedModels: [...unpriced],
    cliGapExceeds1Pct: cliReported && totalUsd > 0 && Math.abs(cliUsd - totalUsd) / totalUsd > 0.01,
  };
}

const n = (v: number | undefined) => (v === undefined ? "-" : v.toLocaleString("en-US"));

function lineText(l: CostLine, withCache: boolean): string {
  const cache = withCache ? ` | cache read ${n(l.cacheReadTokens)} | cache write 5m ${n(l.cacheWrite5mTokens)} | cache write 1h ${n(l.cacheWrite1hTokens)}` : "";
  return `${l.stage} (${l.model}): ${l.calls} calls | input ${n(l.inputTokens)}${cache} | output ${n(l.outputTokens)} | $${l.usd.toFixed(4)}`;
}

export function formatCostReport(report: CostReport): string {
  const out = report.lines.map((l) => lineText(l, report.hasCacheTokens));
  out.push(`total $${report.totalUsd.toFixed(4)} (price table v${PRICE_TABLE_VERSION})`);
  if (report.baselineUsd !== undefined && report.baselineRatio !== undefined) {
    out.push(`${(report.baselineRatio * 100).toFixed(1)}% of $${report.baselineUsd.toFixed(2)} baseline`);
  }
  if (report.unpricedModels.length > 0) out.push(`unpriced models, total is a floor: ${report.unpricedModels.join(", ")}`);
  if (report.cliGapExceeds1Pct) out.push("warning: CLI-reported cost differs from the priced total by more than 1%");
  return out.join("\n");
}
