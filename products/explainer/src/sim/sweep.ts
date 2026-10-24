import type { SimModel } from "./model.js";
import { runPure } from "./pure-run.js";
import type { SimAxis, SimTraceRun } from "./trace-schema.js";

/** A swept model before it is frozen: every trace field but the schema tag, doctrine sha and sha. */
export interface SimSweep {
  model: string;
  version: string;
  seed: number | string;
  params: Record<string, number>;
  sweep: SimAxis;
  facet?: SimAxis;
  runs: SimTraceRun[];
}

function checkAxes(base: Record<string, number>, axes: SimAxis[]): void {
  for (const axis of axes) {
    if (!(axis.param in base)) throw new Error(`sweep param ${axis.param} is not a model param`);
    if (new Set(axis.values).size !== axis.values.length) throw new Error(`sweep param ${axis.param} repeats a value`);
  }
  if (axes.length === 2 && axes[0]!.param === axes[1]!.param) throw new Error(`facet param ${axes[0]!.param} is also the swept param`);
}

/** Each point's own seed, so adding a point leaves every other point's run unchanged. */
const pointSeed = (seed: number | string, at: [string, number][]): string =>
  [String(seed), ...at.map(([param, value]) => `${param}=${value}`)].join(":");

/**
 * Runs `model` once per value of the swept param (times each facet value, when given), each run
 * on the base params with that point's values swapped in.
 */
export function sweepSim<P extends Record<string, number>>(model: SimModel<P>, base: P, axis: SimAxis, seed: number | string, facet?: SimAxis): SimSweep {
  const axes = facet ? [axis, facet] : [axis];
  checkAxes(base, axes);
  const facetValues: (number | undefined)[] = facet ? facet.values : [undefined];
  const runs = facetValues.flatMap((facetValue) =>
    axis.values.map((value) => {
      const at: [string, number][] = [[axis.param, value]];
      if (facet && facetValue !== undefined) at.push([facet.param, facetValue]);
      const run = runPure(model, { ...base, ...Object.fromEntries(at) }, pointSeed(seed, at));
      return { at: Object.fromEntries(at), ...run };
    }),
  );
  return { model: model.id, version: model.version, seed, params: { ...base }, sweep: axis, ...(facet ? { facet } : {}), runs };
}
