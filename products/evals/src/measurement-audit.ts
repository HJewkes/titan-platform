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

/**
 * A gold gap is found by a slice that names one of its key metrics, and a slice finds at most one gap.
 * Gaps share key metrics, so a first-match assignment depends on slice order; a maximum bipartite
 * matching (augmenting paths) counts the most gaps any assignment can find.
 */
function countGapsFound(gold: AuditGold, output: AuditOutput): number {
  const candidates = gold.gaps.map((gap) =>
    output.slices.flatMap((slice, index) => (slice.metrics.some((id) => gap.keyMetrics.includes(id)) ? [index] : [])),
  );
  const gapOfSlice = new Map<number, number>();
  const augment = (gap: number, visited: Set<number>): boolean =>
    (candidates[gap] ?? []).some((slice) => {
      if (visited.has(slice)) return false;
      visited.add(slice);
      const holder = gapOfSlice.get(slice);
      if (holder !== undefined && !augment(holder, visited)) return false;
      gapOfSlice.set(slice, gap);
      return true;
    });
  return candidates.filter((_, gap) => augment(gap, new Set())).length;
}

export function scoreMeasurementAudit(gold: AuditGold, output: AuditOutput): AuditScore {
  const proposed = new Set(output.metrics.map((metric) => metric.id));
  return {
    metricRecall: recall(gold.metrics.filter((id) => proposed.has(id)).length, gold.metrics.length),
    gapRecall: recall(countGapsFound(gold, output), gold.gaps.length),
    costUsd: output.costUsd,
  };
}
