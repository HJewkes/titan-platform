import type { Db } from "@titan-design/store-sqlite";
import { readSeries, type Level, type Series, type SeriesFilter } from "./queries.js";
import { storeStats, type TimingStoreStats } from "./store.js";
import {
  ANOMALY_RULE,
  GROWTH_RULE,
  growthOf,
  runVerdicts,
  shiftAt,
  trendOf,
  type AnomalyRule,
  type Growth,
  type GrowthRule,
  type RunVerdict,
  type Shift,
} from "./trend.js";

export interface SeriesId {
  level: Level;
  runnerClass: string;
  project: string | null;
  file: string | null;
}

const idOf = ({ level, runnerClass, project, file }: Series): SeriesId => ({ level, runnerClass, project, file });

export interface GrowthFinding extends SeriesId {
  growth: Growth;
}

export interface ProjectTrend extends SeriesId {
  runs: number;
  trend: Growth | null;
}

export interface SuiteRuns {
  runnerClass: string;
  /** The newest runs, oldest first, each against its rolling minimum. */
  verdicts: RunVerdict[];
}

export interface TimingReport {
  generatedAt: string;
  stats: TimingStoreStats;
  rules: { growth: GrowthRule; anomaly: AnomalyRule };
  suites: SuiteRuns[];
  anomalies: (RunVerdict & { runnerClass: string })[];
  growth: GrowthFinding[];
  projects: ProjectTrend[];
}

export interface ReportOptions extends SeriesFilter {
  growth?: Partial<GrowthRule>;
  anomaly?: Partial<AnomalyRule>;
  /** How many of the newest suite runs the report lists per runner class. */
  recentRuns?: number;
  now?: number;
}

const byDelta = (a: GrowthFinding, b: GrowthFinding) => b.growth.deltaMs - a.growth.deltaMs;

function growthFindings(series: Series[], rule: GrowthRule): GrowthFinding[] {
  return series.flatMap((entry) => {
    const growth = growthOf(entry.points, rule);
    return growth ? [{ ...idOf(entry), growth }] : [];
  });
}

function suiteRuns(suites: Series[], rule: AnomalyRule, recentRuns: number): SuiteRuns[] {
  return suites.map((suite) => ({ runnerClass: suite.runnerClass, verdicts: runVerdicts(suite.points, rule).slice(-recentRuns) }));
}

/**
 * Growth (a file, project or the suite whose min-of-last-N rose over its trailing baseline), anomalies (a suite run
 * over its rolling minimum) and every project's trend, over the full-scope runs the filter admits.
 */
export function timingReport(db: Db, options: ReportOptions = {}): TimingReport {
  const rules = { growth: { ...GROWTH_RULE, ...options.growth }, anomaly: { ...ANOMALY_RULE, ...options.anomaly } };
  const [suites, projects, files] = (["suite", "project", "file"] as const).map((level) => readSeries(db, level, options));
  const suiteVerdicts = suiteRuns(suites ?? [], rules.anomaly, options.recentRuns ?? 10);
  return {
    generatedAt: new Date(options.now ?? Date.now()).toISOString(),
    stats: storeStats(db),
    rules,
    suites: suiteVerdicts,
    anomalies: suiteVerdicts.flatMap(({ runnerClass, verdicts }) => verdicts.filter((verdict) => verdict.anomalous).map((verdict) => ({ ...verdict, runnerClass }))),
    growth: [suites, projects, files].flatMap((level) => growthFindings(level ?? [], rules.growth)).sort(byDelta),
    projects: (projects ?? []).map((entry) => ({ ...idOf(entry), runs: entry.points.length, trend: trendOf(entry.points, rules.growth) })),
  };
}

export interface SlowerOptions extends SeriesFilter {
  /** How many runs before the cut make the "before" minimum. */
  window?: number;
  threshold?: number;
  floorMs?: number;
}

export interface SlowerFinding extends SeriesId {
  shift: Shift;
}

/** Every suite, project and file whose minimum after `cutMs` rose over its minimum before it, largest rise first. */
export function slowerSince(db: Db, cutMs: number, options: SlowerOptions = {}): SlowerFinding[] {
  const { window = 10, threshold = 0.1, floorMs = 500 } = options;
  const levels = (["suite", "project", "file"] as const).flatMap((level) => readSeries(db, level, options));
  return levels
    .flatMap((entry) => {
      const shift = shiftAt(entry.points, cutMs, window);
      return shift && shift.ratio >= threshold && shift.deltaMs >= floorMs ? [{ ...idOf(entry), shift }] : [];
    })
    .sort((a, b) => b.shift.deltaMs - a.shift.deltaMs);
}
