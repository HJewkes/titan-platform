export interface Quantiles {
  p10: number;
  p50: number;
  p80: number;
  p90: number;
}

export interface WeightedValue {
  value: number;
  weight: number;
}

const PROBABILITIES = { p10: 0.1, p50: 0.5, p80: 0.8, p90: 0.9 } as const;
// Summed recency weights carry float error; without slack an exact boundary can skip a step.
const RELATIVE_SLACK = 1e-9;

/** Inverse of the weighted empirical CDF: the smallest value whose cumulative weight reaches p. */
export function weightedQuantiles(points: readonly WeightedValue[]): Quantiles {
  const sorted = [...points].sort((a, b) => a.value - b.value);
  const total = sorted.reduce((sum, point) => sum + point.weight, 0);
  const at = (p: number): number => {
    const target = p * total - RELATIVE_SLACK * total;
    let cumulative = 0;
    for (const point of sorted) {
      cumulative += point.weight;
      if (cumulative >= target) return point.value;
    }
    return sorted[sorted.length - 1]?.value ?? Number.NaN;
  };
  return {
    p10: at(PROBABILITIES.p10),
    p50: at(PROBABILITIES.p50),
    p80: at(PROBABILITIES.p80),
    p90: at(PROBABILITIES.p90),
  };
}
