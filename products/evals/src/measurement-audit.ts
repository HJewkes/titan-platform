import { measurementAuditReadSchema } from "@titan-design/health/metrics";
import type { MeasurementAuditRead } from "@titan-design/health/metrics";

/** A gold metric is known by its name and aliases; its id is the source audit's own label and never matched. */
export interface GoldMetric {
  id: string;
  name: string;
  aliases?: string[];
}

/** A gold gap is closed by a slice that names its key metrics (gold metric ids). */
export interface GoldGap {
  id: string;
  title: string;
  keyMetrics: string[];
}

/** The gold answer of a measurement-audit case: the metrics an audit should propose and the gaps it should rank. */
export interface AuditGold {
  metrics: GoldMetric[];
  gaps: GoldGap[];
}

/** What the harness recorded for the run; the report itself carries no cost. */
export interface AuditRun {
  costUsd: number;
}

export interface AuditScore {
  metricRecall: number;
  metricPrecision: number;
  metricF1: number;
  gapRecall: number;
  gapPrecision: number;
  gapF1: number;
  costUsd: number;
}

const NAME_SIMILARITY = 0.5;
const SLICE_FOCUS = 1 / 3;
const SUFFIXES = ["ing", "ion", "ed", "es", "s", "e"];
const STOPWORDS = new Set(["a", "an", "the", "of", "per", "by", "to", "on", "in", "for", "and", "or", "vs", "versus", "with", "from", "at", "is", "not", "no"]);

const share = (found: number, total: number): number => (total === 0 ? 0 : found / total);
const f1 = (precision: number, recall: number): number => (precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall));

/** Strips one inflection so "merged", "merges" and "merge" meet; it only needs to agree with itself, not with a dictionary. */
function stem(word: string): string {
  const suffix = SUFFIXES.find((ending) => word.endsWith(ending) && !word.endsWith("ss") && word.length - ending.length >= 3);
  return suffix ? word.slice(0, -suffix.length) : word;
}

function words(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word && !STOPWORDS.has(word)).map(stem));
}

/** Dice overlap of content words, so a title stuffed with every name stays far from each of them. */
function similarity(a: Set<string>, b: Set<string>): number {
  const shared = [...a].filter((word) => b.has(word)).length;
  return share(2 * shared, a.size + b.size);
}

function nameSimilarity(title: string, gold: GoldMetric): number {
  const titleWords = words(title);
  return Math.max(...[gold.name, ...(gold.aliases ?? [])].map((name) => similarity(titleWords, words(name))));
}

/** The gold metrics a title is close enough to, closest first, so the matching gives each title its best free name. */
function namedBy(title: string, gold: AuditGold): number[] {
  return gold.metrics
    .map((goldMetric, index) => ({ index, score: nameSimilarity(title, goldMetric) }))
    .filter(({ score }) => score >= NAME_SIMILARITY)
    .sort((a, b) => b.score - a.score)
    .map(({ index }) => index);
}

/** A maximum one-to-one matching by augmenting paths; `candidates[left]` lists the right nodes left may take. Returns right to left. */
function maximumMatching(candidates: readonly (readonly number[])[]): Map<number, number> {
  const leftOf = new Map<number, number>();
  const augment = (left: number, visited: Set<number>): boolean =>
    (candidates[left] ?? []).some((right) => {
      if (visited.has(right)) return false;
      visited.add(right);
      const holder = leftOf.get(right);
      if (holder !== undefined && !augment(holder, visited)) return false;
      leftOf.set(right, left);
      return true;
    });
  candidates.forEach((_, left) => augment(left, new Set()));
  return leftOf;
}

/** Each report metric id mapped to the one gold metric id it was matched to. */
function matchMetrics(gold: AuditGold, report: MeasurementAuditRead): Map<string, string> {
  const candidates = report.metrics.map((metric) => namedBy(metric.title, gold));
  const matched = new Map<string, string>();
  for (const [goldIndex, reportIndex] of maximumMatching(candidates)) {
    const reportMetric = report.metrics[reportIndex];
    const goldMetric = gold.metrics[goldIndex];
    if (reportMetric && goldMetric) matched.set(reportMetric.id, goldMetric.id);
  }
  return matched;
}

/** A slice closes a gap when a third or more of the metrics it names are that gap's key metrics, so naming everything closes nothing. */
function closes(slice: readonly string[], gap: GoldGap, toGold: Map<string, string>): boolean {
  const hits = new Set(slice.flatMap((id) => toGold.get(id) ?? []).filter((id) => gap.keyMetrics.includes(id))).size;
  return hits > 0 && hits / slice.length >= SLICE_FOCUS;
}

/** Parses a `titan.measurement-audit/v1` report and scores it against the gold audit; cost comes from the run. */
export function scoreMeasurementAudit(gold: AuditGold, report: unknown, run: AuditRun): AuditScore {
  const audit = measurementAuditReadSchema.parse(report);
  const toGold = matchMetrics(gold, audit);
  // The registry slice names no metric and every audit appends it, so it is neither a hit nor a miss.
  const slices = audit.gaps.map((gap) => gap.metric).filter((metrics) => metrics.length > 0);
  const gapsClosed = maximumMatching(slices.map((slice) => gold.gaps.flatMap((gap, index) => (closes(slice, gap, toGold) ? [index] : [])))).size;
  const metricRecall = share(toGold.size, gold.metrics.length);
  const metricPrecision = share(toGold.size, audit.metrics.length);
  const gapRecall = share(gapsClosed, gold.gaps.length);
  const gapPrecision = share(gapsClosed, slices.length);
  return { metricRecall, metricPrecision, metricF1: f1(metricPrecision, metricRecall), gapRecall, gapPrecision, gapF1: f1(gapPrecision, gapRecall), costUsd: run.costUsd };
}
