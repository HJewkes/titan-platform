import type { Observation } from "../extractors/types.js";

export interface FrequencyDistribution {
  values: Map<string | number | boolean, number>;
  total: number;
  dominant: string | number | boolean;
  consistency: number;
}

export function groupByType(
  observations: Observation[],
): Map<string, Observation[]> {
  const groups = new Map<string, Observation[]>();

  for (const obs of observations) {
    const existing = groups.get(obs.type) ?? [];
    existing.push(obs);
    groups.set(obs.type, existing);
  }

  return groups;
}

export function computeDistribution(
  observations: Observation[],
): FrequencyDistribution {
  const valueCounts = new Map<string | number | boolean, number>();

  for (const obs of observations) {
    const key = normalizeValue(obs.value);
    valueCounts.set(key, (valueCounts.get(key) ?? 0) + 1);
  }

  const total = observations.length;

  let dominant: string | number | boolean = "";
  let maxCount = 0;

  for (const [value, count] of valueCounts) {
    if (count > maxCount) {
      maxCount = count;
      dominant = value;
    }
  }

  return {
    values: valueCounts,
    total,
    dominant,
    consistency: total > 0 ? maxCount / total : 0,
  };
}

function normalizeValue(value: unknown): string | number | boolean {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return JSON.stringify(value);
  }
  return String(value);
}

export function selectExamples(
  observations: Observation[],
  maxExamples: number,
): Observation[] {
  if (observations.length <= maxExamples) {
    return [...observations];
  }

  const step = Math.floor(observations.length / maxExamples);
  const examples: Observation[] = [];

  for (
    let i = 0;
    i < observations.length && examples.length < maxExamples;
    i += step
  ) {
    examples.push(observations[i]!);
  }

  return examples;
}
