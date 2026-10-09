/** The gold answer of a measurement-audit case: the metrics an audit should propose and the gaps it should rank. */
export interface AuditGold {
  metrics: string[];
  gaps: { id: string; keyMetrics: string[] }[];
}

/** What a measurement-audit run produces: proposed metrics, gap slices (each naming the metrics it unblocks) and spend. */
export interface AuditOutput {
  metrics: { id: string }[];
  slices: { title: string; metrics: string[] }[];
  costUsd: number;
}

export interface AuditScore {
  metricRecall: number;
  gapRecall: number;
  costUsd: number;
}

const recall = (found: number, total: number): number => (total === 0 ? 0 : found / total);

/** A gold gap is found by an unclaimed slice that names one of its key metrics; a slice claims at most one gap. */
function countGapsFound(gold: AuditGold, output: AuditOutput): number {
  const claimed = new Set<number>();
  for (const gap of gold.gaps) {
    const match = output.slices.findIndex((slice, index) => !claimed.has(index) && slice.metrics.some((id) => gap.keyMetrics.includes(id)));
    if (match >= 0) claimed.add(match);
  }
  return claimed.size;
}

export function scoreMeasurementAudit(gold: AuditGold, output: AuditOutput): AuditScore {
  const proposed = new Set(output.metrics.map((metric) => metric.id));
  return {
    metricRecall: recall(gold.metrics.filter((id) => proposed.has(id)).length, gold.metrics.length),
    gapRecall: recall(countGapsFound(gold, output), gold.gaps.length),
    costUsd: output.costUsd,
  };
}
