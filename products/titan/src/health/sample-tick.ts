import type { HealthSample, HealthSampleInput } from "@titan-design/health";
import { measureSelf } from "./self-cost.js";
import type { HealthTarget } from "./targets.js";

export interface SampleTickDeps {
  probe: (target: HealthTarget) => Promise<HealthSample>;
  /** Writes every row in one transaction and returns how many it wrote. */
  append: (rows: readonly HealthSampleInput[]) => number;
  measureSelf?: (targets: number) => HealthSampleInput;
}

/** One tick: probe every target in parallel, add the self row, then write them all in one append. */
export async function sampleTick(targets: readonly HealthTarget[], deps: SampleTickDeps): Promise<number> {
  const samples = await Promise.all(targets.map((target) => deps.probe(target)));
  const self = (deps.measureSelf ?? measureSelf)(targets.length);
  return deps.append([...samples, self]);
}
