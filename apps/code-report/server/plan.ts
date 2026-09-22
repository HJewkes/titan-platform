import type { QueryResolver } from "@titan-design/code-read";
import { CALLS, NO_FILTERS, overviewMetrics } from "../src/data/calls.js";

export interface PlannedCall {
  command: string;
  args: unknown;
}

/** What each page asks for on first paint, plus every finding; anything else is answered by the resolver. */
export function firstPaintCalls(snapshot: number, resolve: QueryResolver): PlannedCall[] {
  const describe = resolve("api.describe", CALLS.describe());
  const counts = resolve("findings.list", { snapshot, limit: 500 });
  if (!describe.ok || !counts.ok) throw new Error("The dataset cannot answer api.describe or findings.list");
  const metrics = overviewMetrics((describe.data as { metrics: Parameters<typeof overviewMetrics>[0] }).metrics).map((m) => m.name);
  const findings = (counts.data as { rows: Array<{ id: string }> }).rows;
  return [
    { command: "api.describe", args: CALLS.describe() },
    { command: "findings.list", args: CALLS.findingCounts(snapshot) },
    { command: "hierarchy.get", args: CALLS.overviewTree(snapshot, metrics) },
    { command: "findings.list", args: CALLS.findingsPage(snapshot, NO_FILTERS, "severity", 0) },
    ...findings.map((f) => ({ command: "finding.get", args: CALLS.finding(snapshot, f.id) })),
  ];
}
