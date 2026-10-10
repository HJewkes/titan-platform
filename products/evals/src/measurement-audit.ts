import { measurementAuditReadSchema } from "@titan-design/health/metrics";
import type { MeasurementAuditRead } from "@titan-design/health/metrics";

/** A gold metric is known by its name, aliases, definition and key words; its id is the source audit's own label and never matched. */
export interface GoldMetric {
  id: string;
  name: string;
  aliases?: string[];
  definition: string;
  /** Words that set this metric apart from its neighbours; a title must use one. */
  keyWords: string[];
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

const SLICE_FOCUS = 1 / 3;
const SUFFIXES = ["ing", "ion", "ed", "es", "s", "e"];
const STOPWORDS = new Set([
  "a", "an", "the", "of", "per", "by", "to", "on", "in", "for", "and", "or", "vs", "versus", "with", "from", "at", "is", "not", "no",
  "each", "every", "how", "far", "much", "many", "when", "it", "its", "this", "that", "as", "be", "are", "was", "has", "have", "spend", "needed", "done", "between", "against",
]);
/** Words that say how a metric is measured, not what it measures: allowed in a title, never enough to match one. */
const MEASURES = new Set(["count", "rate", "share", "number", "total", "median", "average", "ratio", "percent", "p50", "p90", "time", "length"].map(stem));

const share = (found: number, total: number): number => (total === 0 ? 0 : found / total);
const f1 = (precision: number, recall: number): number => (precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall));

/** Strips one inflection so "merged", "merges" and "merge" meet; it only needs to agree with itself, not with a dictionary. */
function stem(word: string): string {
  const suffix = SUFFIXES.find((ending) => word.endsWith(ending) && !word.endsWith("ss") && word.length - ending.length >= 2);
  return suffix ? word.slice(0, -suffix.length) : word;
}

function words(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9_]+/).filter((word) => word && !STOPWORDS.has(word)).map(stem));
}

const normalized = (text: string): string => [...words(text)].join(" ");

/** Dice overlap of content words; it only orders a title's candidates, the match itself is decided by `names`. */
function similarity(title: Set<string>, name: Set<string>): number {
  const shared = [...title].filter((word) => name.has(word)).length;
  return share(2 * shared, title.size + name.size);
}

function nameSimilarity(title: string, gold: GoldMetric): number {
  const titleWords = words(title);
  return Math.max(...[gold.name, ...(gold.aliases ?? [])].map((name) => similarity(titleWords, words(name))));
}

/**
 * A title names a gold metric when it repeats the name or an alias, or when it has two content words, every word is in
 * that metric's own vocabulary, and one is a key word that sets the metric apart. Shared domain words ("merged PR",
 * "per day", "review") are never enough alone, and a word the metric cannot explain ("conflicts", "commits") rules it out.
 */
function names(title: string, gold: GoldMetric): boolean {
  const labels = [gold.name, ...(gold.aliases ?? [])];
  if (labels.some((label) => normalized(label) === normalized(title))) return true;
  const vocabulary = words([...labels, gold.definition, ...gold.keyWords].join(" "));
  const content = [...words(title)].filter((word) => !MEASURES.has(word));
  const keyWords = words(gold.keyWords.join(" "));
  return content.length >= 2 && content.every((word) => vocabulary.has(word)) && content.some((word) => keyWords.has(word));
}

/** The gold metrics a title names, closest first, so the matching gives each title its best free metric. */
function namedBy(title: string, gold: AuditGold): number[] {
  return gold.metrics
    .map((goldMetric, index) => ({ index, named: names(title, goldMetric), score: nameSimilarity(title, goldMetric) }))
    .filter(({ named }) => named)
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
