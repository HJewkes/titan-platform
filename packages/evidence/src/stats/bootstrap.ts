import type { Interval } from "./intervals.js";
export interface BootstrapOptions {
  confidence?: number;
  resamples?: number;
  seed?: string | number;
  statistic?: (sample: readonly number[]) => number;
}
export function bootstrapCI(_v: readonly number[], _o?: BootstrapOptions): Interval {
  throw new Error("stub");
}
export function pairedBootstrap(_a: readonly number[], _b: readonly number[], _o?: Omit<BootstrapOptions, "statistic">): Interval {
  throw new Error("stub");
}
