/** One measurement of a series: a file's or a project's or a whole run's total ms in one full-suite run. */
export interface Point {
  runId: string;
  commit: string | null;
  startedMs: number;
  ms: number;
}

export interface GrowthRule {
  /** The last N points; their minimum is the current level, so one slow run cannot move it. */
  recent: number;
  /** The points before those; their minimum is the baseline. */
  baseline: number;
  /** Fewest baseline points that make a baseline at all. */
  minBaseline: number;
  /** Fractional rise of the current level over the baseline that counts as growth. */
  threshold: number;
  /** Smallest absolute rise in ms that counts, so a 40 ms file going to 60 ms is not news. */
  floorMs: number;
}

export const GROWTH_RULE: GrowthRule = { recent: 3, baseline: 10, minBaseline: 3, threshold: 0.25, floorMs: 500 };

export interface Growth {
  baselineMs: number;
  currentMs: number;
  deltaMs: number;
  ratio: number;
  /** The first of the recent points: where the rise shows up. */
  since: Point;
}

const minMs = (points: Point[]) => Math.min(...points.map((point) => point.ms));

/** Min-of-last-N against the min of the trailing window before it, whatever the size; null when too short. */
export function trendOf(points: Point[], rule: GrowthRule = GROWTH_RULE): Growth | null {
  const recent = points.slice(-rule.recent);
  const since = recent[0];
  if (since === undefined || points.length < rule.recent + rule.minBaseline) return null;
  const trailing = points.slice(0, -rule.recent).slice(-rule.baseline);
  const baselineMs = minMs(trailing);
  const currentMs = minMs(recent);
  const ratio = baselineMs > 0 ? currentMs / baselineMs - 1 : Number.POSITIVE_INFINITY;
  return { baselineMs, currentMs, deltaMs: currentMs - baselineMs, ratio, since };
}

/** The trend, only when it rose by at least the threshold and the floor. */
export function growthOf(points: Point[], rule: GrowthRule = GROWTH_RULE): Growth | null {
  const trend = trendOf(points, rule);
  return trend && trend.ratio >= rule.threshold && trend.deltaMs >= rule.floorMs ? trend : null;
}

export interface AnomalyRule {
  /** How many earlier runs the rolling minimum spans. */
  window: number;
  /** Fewest earlier runs that make a rolling minimum. */
  minWindow: number;
  /** Fractional excess over the rolling minimum that is an anomaly. */
  threshold: number;
  /** Consecutive runs that must all be over, so one slow hosted runner is not an alarm. */
  hold: number;
}

// Hosted suite totals swing about 6% run to run, so a lone run 10% over the minimum is routine; two in a row 12% over is
// not. A 15% step clears that on its second run, within hours on main.
export const ANOMALY_RULE: AnomalyRule = { window: 10, minWindow: 3, threshold: 0.12, hold: 2 };

export interface RunVerdict {
  point: Point;
  /** Minimum of the `window` runs before the held span; null until there are `minWindow` of them. */
  rollingMinMs: number | null;
  /** This run's own excess over the rolling minimum. */
  ratio: number | null;
  /** The held span's minimum over the rolling minimum: the number the threshold judges. */
  heldRatio: number | null;
  anomalous: boolean;
}

/** Each run's total against the minimum of the runs before it; anomalous once `hold` runs in a row are all over. */
export function runVerdicts(points: Point[], rule: AnomalyRule = ANOMALY_RULE): RunVerdict[] {
  return points.map((point, index) => {
    const heldFrom = index - rule.hold + 1;
    const earlier = points.slice(Math.max(0, heldFrom - rule.window), Math.max(0, heldFrom));
    if (heldFrom < 0 || earlier.length < rule.minWindow) return { point, rollingMinMs: null, ratio: null, heldRatio: null, anomalous: false };
    const rollingMinMs = minMs(earlier);
    const heldRatio = minMs(points.slice(heldFrom, index + 1)) / rollingMinMs - 1;
    return { point, rollingMinMs, ratio: point.ms / rollingMinMs - 1, heldRatio, anomalous: heldRatio >= rule.threshold };
  });
}

export interface Shift {
  beforeMs: number;
  afterMs: number;
  deltaMs: number;
  ratio: number;
  afterRuns: number;
}

/** Min after a cut against the min of the last `window` points before it; null when either side is empty. */
export function shiftAt(points: Point[], cutMs: number, window: number): Shift | null {
  const before = points.filter((point) => point.startedMs < cutMs).slice(-window);
  const after = points.filter((point) => point.startedMs >= cutMs);
  if (before.length === 0 || after.length === 0) return null;
  const beforeMs = minMs(before);
  const afterMs = minMs(after);
  const ratio = beforeMs > 0 ? afterMs / beforeMs - 1 : Number.POSITIVE_INFINITY;
  return { beforeMs, afterMs, deltaMs: afterMs - beforeMs, ratio, afterRuns: after.length };
}
