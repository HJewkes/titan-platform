import type { NodeKind } from "../types.js";

/** The `unit` a metric row is stored with; every row of one metric name carries the same unit. */
export type MetricUnit = "count" | "lines" | "ratio" | "days" | "percent" | "per100loc";

/** How file values combine into a directory; `none` means no rollup reproduces the group's true value. */
export type MetricRollup = "sum" | "max" | "mean" | "none";

/** Which way is worse, for ranking and colouring; `neutral` makes no value judgement. */
export type MetricDirection = "higher-worse" | "lower-worse" | "neutral";

/** A missing row reads as zero (a sparse writer's floor) or is left out of means, percentiles, and ranks. */
export type MetricAbsence = "zero" | "exclude";

/** The code-graph module that writes the metric, for provenance. */
export type MetricSource =
  | "degree"
  | "source-metrics"
  | "lcom"
  | "exception-handling"
  | "dead-code"
  | "growth-risk"
  | "history"
  | "test-linker"
  | "coverage";

export interface MetricDescriptor {
  /** The stored name, or a template such as `churn_{w}` when {@link windowed} is set. */
  name: string;
  unit: MetricUnit;
  /** Node kinds the writer attaches this metric to. */
  appliesTo: readonly NodeKind[];
  rollup: MetricRollup;
  direction: MetricDirection;
  absent: MetricAbsence;
  source: MetricSource;
  description: string;
  /** Set on templates: `{w}` in `name` and `description` stands for a window such as `30d` or `lifetime`. */
  windowed?: true;
  /** Set on a resolved windowed descriptor: the window its name carries. */
  window?: string;
}
