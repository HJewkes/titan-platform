import { monitorEventLoopDelay } from "node:perf_hooks";
import type { Logger } from "@titan-design/daemon";

/** The slice of node's `IntervalHistogram` the watch reads; values are nanoseconds. */
export interface LoopDelayHistogram {
  enable(): boolean;
  disable(): boolean;
  reset(): void;
  percentile(percentile: number): number;
  readonly max: number;
}

export interface LoopDelayWatchOptions {
  log: Logger;
  thresholdMs?: number;
  windowMs?: number;
  histogram?: LoopDelayHistogram;
}

export interface LoopDelayWatch {
  stop(): void;
}

const NS_PER_MS = 1e6;

/**
 * Warns once per window whose worst event-loop delay passed the threshold.
 * It triggers on max, not p99, because one 15-40 s sync child is a single sample that p99 averages away,
 * and such a block starves workflow lease renewal.
 */
export function startLoopDelayWatch(options: LoopDelayWatchOptions): LoopDelayWatch {
  const { log, thresholdMs = 5_000, windowMs = 60_000 } = options;
  const histogram = options.histogram ?? monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  const timer = setInterval(() => {
    const maxMs = histogram.max / NS_PER_MS;
    if (maxMs > thresholdMs) log.warn({ p99Ms: histogram.percentile(99) / NS_PER_MS, maxMs, windowMs }, "event loop stalled");
    histogram.reset();
  }, windowMs);
  timer.unref();
  return {
    stop() {
      clearInterval(timer);
      histogram.disable();
    },
  };
}
