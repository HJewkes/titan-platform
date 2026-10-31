import { seededRandom } from "@titan-design/evidence";
import { aucInterval, bootstrapCI, wilson } from "@titan-design/evidence/stats";
import { z } from "zod";
import { MIN_REGISTER_WORDS, REGISTER_BANDS, REGISTER_MEASURES, REGISTER_METRICS, spokenText, type RegisterMetric } from "./lint-register.js";
import { rowStatus, type AucContrast, type RowMetrics, type RowStatus, type SpanPrecision, type StatusThresholds, type WritingStatus } from "./writing-status.js";

const WRITING_SCHEMA = "writing-check/v1";
const SEED = 4662;
const RESAMPLES = 2000;
const RATE_RESAMPLES = 1000;
const FOLDS = 5;
const MAX_WINDOWS_PER_TEXT = 4;

/** Scripts are scored in their own length bucket; `full` is whole texts of any scorable length. */
export const WRITING_BUCKETS = [
  { name: "150-299", lo: 150, hi: 299, mid: 225 },
  { name: "300-599", lo: 300, hi: 599, mid: 450 },
  { name: "600-1199", lo: 600, hi: 1199, mid: 900 },
  { name: "1200+", lo: 1200, hi: Infinity, mid: 1500 },
  { name: "full", lo: 150, hi: Infinity, mid: Infinity },
] as const;
type Bucket = (typeof WRITING_BUCKETS)[number];
export type BucketName = Bucket["name"];
const PRIMARY_BUCKET: BucketName = "300-599";

type AiGroup = "ours-new" | "ai-other" | "ours" | "ours-new-native";

/** One corpus text: only ids, labels and whitespace tokens, so nothing here can carry text into the output by accident. */
export interface CorpusDoc {
  id: string;
  label: "human" | "ai-other" | "ours" | "ours-new";
  set: string;
  cluster: string;
  tokens: readonly string[];
}

interface Window {
  doc: CorpusDoc;
  bucket: BucketName;
  values: ReadonlyMap<RegisterMetric, number | undefined>;
}

/** `n` counts windows, which are not independent; `clusters` counts what the bootstrap resamples. */
interface RateCell {
  k: number;
  n: number;
  clusters: number;
  point: number | null;
  wilson: readonly [number, number];
}

interface AucCell extends AucContrast {
  auc: number;
  nNeg: number;
  clustersPos: number;
  clustersNeg: number;
}

interface GroupCell {
  tpr: RateCell;
  texts: number;
  auc_heldout: AucCell | null;
  auc_all_human: AucCell | null;
}

type RowCell = {
  fpr_heldout: RateCell & { texts: number; clusterCI: readonly number[] | null };
  fpr_creator: RateCell;
  fpr_auto: RateCell;
  fpr_all_human: RateCell;
} & Record<AiGroup, GroupCell>;

interface WritingCheckInput {
  docs: readonly CorpusDoc[];
  thresholds: StatusThresholds;
  precision: Readonly<Record<string, SpanPrecision>>;
  manifestSha256: string;
  sourceSha: string;
}

/**
 * A text inside the bucket is used whole. A longer one gives up to 4 non-overlapping windows of the bucket's midpoint,
 * evenly spread, so a long lecture cannot dominate.
 */
export function windowsOf(tokens: readonly string[], bucket: Bucket): (readonly string[])[] {
  const total = tokens.length;
  if (total < bucket.lo) return [];
  if (bucket.name === "full" || total <= bucket.hi) return [tokens];
  const count = Math.min(MAX_WINDOWS_PER_TEXT, Math.floor(total / bucket.mid));
  return Array.from({ length: count }, (_, i) => {
    const start = Math.floor((i * total) / count);
    return tokens.slice(start, start + bucket.mid);
  });
}

/** How far a value sits outside the shipped band, as a share of the edge it crossed; 0 inside. */
function bandDistance(metric: RegisterMetric, value: number): number {
  const band = REGISTER_BANDS[metric];
  if (band.min !== undefined && value < band.min) return (band.min - value) / band.min;
  return value > band.max ? (value - band.max) / band.max : 0;
}

function allWindows(docs: readonly CorpusDoc[]): Window[] {
  return docs.flatMap((doc) =>
    WRITING_BUCKETS.flatMap((bucket) =>
      windowsOf(doc.tokens, bucket).map((tokens) => {
        const parsed = spokenText([tokens.join(" ")]);
        const judged = parsed.words.length >= MIN_REGISTER_WORDS;
        const values = new Map(REGISTER_METRICS.map((metric) => [metric, judged ? REGISTER_MEASURES[metric](parsed) : undefined]));
        return { doc, bucket: bucket.name, values };
      }),
    ),
  );
}

const measured = (windows: readonly Window[], metric: RegisterMetric): { doc: CorpusDoc; value: number }[] =>
  windows.flatMap((w) => {
    const value = w.values.get(metric);
    return value === undefined ? [] : [{ doc: w.doc, value }];
  });

const compareKeys = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const distinct = (keys: readonly string[]): number => new Set(keys).size;
const byCluster = <T extends { doc: CorpusDoc }>(items: readonly T[]): T[] => [...items].sort((a, b) => compareKeys(a.doc.cluster, b.doc.cluster));

function rate(windows: readonly Window[], metric: RegisterMetric): RateCell {
  const items = measured(windows, metric);
  const k = items.filter((item) => bandDistance(metric, item.value) > 0).length;
  const n = items.length;
  const clusters = distinct(items.map((item) => item.doc.cluster));
  if (n === 0) return { k, n, clusters, point: null, wilson: [0, 1] };
  const interval = wilson(k, n);
  return { k, n, clusters, point: k / n, wilson: [interval.lower, interval.upper] };
}

/** A flagged rate's bootstrap interval, drawing whole clusters, so windows of one text or channel move together. */
function clusterRateInterval(flags: readonly { flagged: boolean; cluster: string }[], seed: string): readonly number[] {
  const tallies = new Map<string, { k: number; n: number }>();
  for (const { flagged, cluster } of [...flags].sort((a, b) => compareKeys(a.cluster, b.cluster))) {
    const tally = tallies.get(cluster) ?? { k: 0, n: 0 };
    tally.n += 1;
    if (flagged) tally.k += 1;
    tallies.set(cluster, tally);
  }
  const groups = [...tallies.values()];
  const pooled = (drawn: readonly number[]): number => {
    const picked = drawn.flatMap((i) => groups[i] ?? []);
    const n = picked.reduce((sum, group) => sum + group.n, 0);
    return n === 0 ? 0 : picked.reduce((sum, group) => sum + group.k, 0) / n;
  };
  const interval = bootstrapCI(groups.map((_, i) => i), { resamples: RATE_RESAMPLES, seed, statistic: pooled });
  return [round(interval.lower, 4), round(interval.upper, 4)];
}

const round = (value: number, digits: number): number => Math.round(value * 10 ** digits) / 10 ** digits;

const seedFor = (key: string): string => `${SEED}|${key}`;

function contrast(pos: readonly Window[], neg: readonly Window[], metric: RegisterMetric, key: string): AucCell | null {
  const scored = (windows: readonly Window[]) => byCluster(measured(windows, metric)).map((item) => ({ score: bandDistance(metric, item.value), cluster: item.doc.cluster }));
  const positives = scored(pos);
  const negatives = scored(neg);
  if (positives.length < 3 || negatives.length < 3) return null;
  const clusters = { pos: positives.map((item) => item.cluster), neg: negatives.map((item) => item.cluster) };
  const interval = aucInterval(positives.map((item) => item.score), negatives.map((item) => item.score), { clusters, resamples: RESAMPLES, seed: seedFor(key) });
  return {
    auc: round(interval.estimate, 4), lo: round(interval.lower, 4), hi: round(interval.upper, 4),
    nPos: positives.length, nNeg: negatives.length, clustersPos: distinct(clusters.pos), clustersNeg: distinct(clusters.neg),
  };
}

const isHeldOutHuman = (doc: CorpusDoc): boolean => doc.set === "human-ontopic";
const isHuman = (doc: CorpusDoc): boolean => doc.label === "human";
const textCount = (windows: readonly Window[], metric: RegisterMetric): number => distinct(measured(windows, metric).map((item) => item.doc.id));

function bucketNamed(name: BucketName): Bucket {
  const bucket = WRITING_BUCKETS.find((candidate) => candidate.name === name);
  if (bucket === undefined) throw new Error(`unknown bucket ${name}`);
  return bucket;
}

/** `ours-new-native`: scripts whose own length falls in the bucket, never cut from a longer one. */
function belongsTo(doc: CorpusDoc, group: AiGroup, bucketName: BucketName): boolean {
  if (group !== "ours-new-native") return doc.label === group;
  const bucket = bucketNamed(bucketName);
  return doc.label === "ours-new" && doc.tokens.length >= bucket.lo && doc.tokens.length <= bucket.hi;
}

function fprHeldOut(held: readonly Window[], metric: RegisterMetric, bucket: BucketName): RowCell["fpr_heldout"] {
  const flags = measured(held, metric).map((item) => ({ flagged: bandDistance(metric, item.value) > 0, cluster: item.doc.cluster }));
  return { ...rate(held, metric), texts: textCount(held, metric), clusterCI: flags.length > 0 ? clusterRateInterval(flags, seedFor(`fpr|${metric}|${bucket}`)) : null };
}

function rowCell(windows: readonly Window[], metric: RegisterMetric, bucket: BucketName): RowCell {
  const inBucket = (keep: (doc: CorpusDoc) => boolean): Window[] => windows.filter((w) => w.bucket === bucket && keep(w.doc));
  const held = inBucket(isHeldOutHuman);
  const humans = inBucket(isHuman);
  const group = (name: AiGroup): GroupCell => {
    const pos = inBucket((doc) => belongsTo(doc, name, bucket));
    return {
      tpr: rate(pos, metric), texts: textCount(pos, metric),
      auc_heldout: contrast(pos, held, metric, `${metric}|${bucket}|${name}|held`),
      auc_all_human: contrast(pos, humans, metric, `${metric}|${bucket}|${name}|all`),
    };
  };
  return {
    fpr_heldout: fprHeldOut(held, metric, bucket),
    fpr_creator: rate(inBucket((doc) => doc.set === "human-creator"), metric),
    fpr_auto: rate(inBucket((doc) => doc.set === "human-auto"), metric),
    fpr_all_human: rate(humans, metric),
    "ours-new": group("ours-new"), "ai-other": group("ai-other"), ours: group("ours"), "ours-new-native": group("ours-new-native"),
  };
}

/** The status rule's inputs, read from a row's cell. S3 and the shipped-status test read a cell the same way. */
export function metricsOf(cell: RowCell, precision: SpanPrecision | undefined): RowMetrics {
  const { n, point, wilson: bounds } = cell.fpr_heldout;
  return {
    oursNew: cell["ours-new"].auc_heldout ?? undefined,
    aiOther: cell["ai-other"].auc_heldout ?? undefined,
    fpr: n > 0 && point !== null ? { n, point, upper: bounds[1] } : undefined,
    precision,
  };
}

function quantile(sorted: readonly number[], q: number): number {
  const position = (sorted.length - 1) * q;
  const low = sorted[Math.floor(position)] ?? Number.NaN;
  const high = sorted[Math.ceil(position)] ?? Number.NaN;
  return low + (high - low) * (position - Math.floor(position));
}

const ascending = (values: readonly number[]): number[] => [...values].sort((a, b) => a - b);

/** Assigns each channel to a fold, by seeded order so that a channel never straddles train and test. */
function channelFolds(channels: readonly string[]): ReadonlyMap<string, number> {
  const random = seededRandom(SEED);
  const shuffled = [...new Set(channels)].sort(compareKeys).map((channel) => ({ channel, draw: random() })).sort((a, b) => a.draw - b.draw);
  return new Map(shuffled.map(({ channel }, i) => [channel, i % FOLDS]));
}

/** How the P25-P90 band-fitting method generalises: fit on four folds of channels, count flags on the fifth. */
function foldRefit(windows: readonly Window[], metric: RegisterMetric) {
  const items = measured(windows.filter((w) => w.bucket === PRIMARY_BUCKET && isHuman(w.doc)), metric);
  const folds = channelFolds(items.map((item) => item.doc.cluster));
  const hasFloor = REGISTER_BANDS[metric].min !== undefined;
  const flags: { flagged: boolean; cluster: string }[] = [];
  for (let fold = 0; fold < FOLDS; fold++) {
    const train = ascending(items.filter((item) => folds.get(item.doc.cluster) !== fold).map((item) => item.value));
    if (train.length < FOLDS) continue;
    const low = hasFloor ? quantile(train, 0.25) : -Infinity;
    const high = quantile(train, 0.9);
    for (const { doc, value } of items.filter((item) => folds.get(item.doc.cluster) === fold)) flags.push({ flagged: value < low || value > high, cluster: doc.cluster });
  }
  const n = flags.length;
  const k = flags.filter((flag) => flag.flagged).length;
  if (n === 0) return { k, n, point: null, wilson: [0, 1], clusterCI: null, windowsPerFold: 0 };
  const interval = wilson(k, n);
  return { k, n, point: round(k / n, 4), wilson: [round(interval.lower, 4), round(interval.upper, 4)], clusterCI: clusterRateInterval(flags, seedFor(`fold|${metric}`)), windowsPerFold: n / FOLDS };
}

/** The band that flags about 10 % of train human windows, and what it flags on held-out text. */
function band10(windows: readonly Window[], metric: RegisterMetric) {
  const primary = windows.filter((w) => w.bucket === PRIMARY_BUCKET);
  const train = ascending(measured(primary.filter((w) => w.doc.set === "human-creator" || w.doc.set === "human-auto"), metric).map((item) => item.value));
  if (train.length < 10) return null;
  const hasFloor = REGISTER_BANDS[metric].min !== undefined;
  const low = hasFloor ? quantile(train, 0.05) : -Infinity;
  const high = quantile(train, hasFloor ? 0.95 : 0.9);
  const held = measured(primary.filter((w) => isHeldOutHuman(w.doc)), metric);
  const heldoutK = held.filter(({ value }) => value < low || value > high).length;
  return {
    lo: Number.isFinite(low) ? round(low, 4) : null, hi: round(high, 4), trainN: train.length,
    heldoutK, heldoutN: held.length, heldoutFpr: held.length > 0 ? round(heldoutK / held.length, 4) : null,
  };
}

function tally(windows: readonly Window[]): Record<string, number> {
  const counts = new Map<string, number>();
  for (const { bucket, doc } of windows) counts.set(`${bucket}|${doc.label}`, (counts.get(`${bucket}|${doc.label}`) ?? 0) + 1);
  return Object.fromEntries([...counts].sort(([a], [b]) => compareKeys(a, b)));
}

const perMetric = <T>(value: (metric: RegisterMetric) => T): Record<RegisterMetric, T> => ({
  numbers: value("numbers"),
  "second-person": value("second-person"),
  we: value("we"),
  "sentence-mean": value("sentence-mean"),
  "sentence-cv": value("sentence-cv"),
  contractions: value("contractions"),
  triads: value("triads"),
  "colon-reveals": value("colon-reveals"),
  "not-x-tails": value("not-x-tails"),
  semicolons: value("semicolons"),
  lets: value("lets"),
  phrases: value("phrases"),
  "neg-synthetic": value("neg-synthetic"),
  downtoners: value("downtoners"),
});
const perBucket = <T>(value: (bucket: BucketName) => T): Record<BucketName, T> => ({
  "150-299": value("150-299"),
  "300-599": value("300-599"),
  "600-1199": value("600-1199"),
  "1200+": value("1200+"),
  full: value("full"),
});

export type WritingCheck = ReturnType<typeof calibrateWriting>;

const WritingCheckSchema = z.custom<WritingCheck>((value) => typeof value === "object" && value !== null && "statusByBucket" in value, "not a writing-check file");

/** Reads writing-check JSON. The file is generated by `calibrateWriting`, so this checks its kind, not every cell. */
export const parseWritingCheck = (raw: string): WritingCheck => WritingCheckSchema.parse(JSON.parse(raw));

function metaOf(input: WritingCheckInput, windows: readonly Window[]) {
  return {
    sourceFile: "products/explainer/src/lint-register.ts", sourceSha: input.sourceSha, manifestSha256: input.manifestSha256,
    seed: SEED, foldSeed: SEED, resamples: RESAMPLES, primaryBucket: PRIMARY_BUCKET, thresholds: input.thresholds,
    buckets: WRITING_BUCKETS.map(({ name, lo, hi, mid }) => ({ name, lo, hi: Number.isFinite(hi) ? hi : null, mid: Number.isFinite(mid) ? mid : null })),
    docs: input.docs.length, windowsByBucketLabel: tally(windows),
    countsNote: "n, nPos and nNeg count windows, which are not independent samples; clusters, clustersPos and clustersNeg count what the bootstrap resamples.",
  };
}

/** The derived metrics and per-bucket statuses. Numbers and ids of metrics only: no corpus text, span or path reaches the result. */
export function calibrateWriting(input: WritingCheckInput) {
  const windows = allWindows(input.docs);
  const rows = perMetric((metric) => perBucket((bucket) => rowCell(windows, metric, bucket)));
  const decide = (metric: RegisterMetric, bucket: BucketName): RowStatus => rowStatus(metricsOf(rows[metric][bucket], input.precision[metric]), input.thresholds);
  const precision = Object.fromEntries(Object.entries(input.precision).map(([metric, { correct, labelled }]) => [metric, { correct, labelled }]));
  return {
    schema: WRITING_SCHEMA,
    provisional: false,
    meta: metaOf(input, windows),
    rows,
    status: perMetric((metric) => decide(metric, PRIMARY_BUCKET)),
    statusByBucket: perMetric((metric): Record<BucketName, WritingStatus> => perBucket((bucket) => decide(metric, bucket).status)),
    statusDetail: perMetric((metric) => perBucket((bucket) => decide(metric, bucket))),
    refit5foldByChannel: perMetric((metric) => foldRefit(windows, metric)),
    band10pct: perMetric((metric) => band10(windows, metric)),
    precision,
  };
}

/** Pretty JSON at 6 decimals; a platform's last-bit float noise must not churn the committed file. */
export const formatWritingCheck = (check: WritingCheck): string =>
  `${JSON.stringify(check, (_key, value: unknown) => (typeof value === "number" ? (Number.isFinite(value) ? round(value, 6) : null) : value), 1)}\n`;
