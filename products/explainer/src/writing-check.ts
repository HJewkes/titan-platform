import { MIN_REGISTER_WORDS, REGISTER_BANDS, REGISTER_MEASURES, spokenText, type Band, type RegisterMetric, type SpokenText } from "./lint-register.js";
import { WRITING_BUCKETS, type BucketName, type WritingCheck } from "./writing-calibrate.js";
import type { WritingStatus } from "./writing-status.js";

const MAX_SPANS = 3;
const SEMICOLON_ONLY = /^\W+$/;

/** The human texts behind every band are performed speech, so a human-ness claim here is relative to transcripts. */
const HUMAN_REFERENCE = "speech transcripts, not written scripts";

export type WritingDimension = "AI-isms" | "rhythm" | "specificity" | "register";

/** In report order. `register` holds the involved-speech rows, kept apart so a speech-only feature cannot read as an AI-ism. */
const ROWS: readonly (readonly [RegisterMetric, WritingDimension])[] = [
  ["phrases", "AI-isms"],
  ["neg-synthetic", "AI-isms"],
  ["triads", "AI-isms"],
  ["colon-reveals", "AI-isms"],
  ["downtoners", "AI-isms"],
  ["not-x-tails", "AI-isms"],
  ["semicolons", "AI-isms"],
  ["lets", "AI-isms"],
  ["sentence-mean", "rhythm"],
  ["sentence-cv", "rhythm"],
  ["numbers", "specificity"],
  ["second-person", "register"],
  ["we", "register"],
  ["contractions", "register"],
];

/** Whole-script shapes: no one place in the text is the offence. */
const SPANLESS: ReadonlySet<RegisterMetric> = new Set(["sentence-mean", "sentence-cv"]);

export interface WritingBeat {
  id: string;
  spoken: string;
}

interface WritingSpan {
  beat: string;
  text: string;
}

/**
 * Where the value sits among held-out human windows at this length. The table holds flag rates, not quantiles, so a capped
 * row gets only the side of its band edge (the edge is the 1 - FPR percentile) and a two-sided row gets its flag rate.
 */
export interface HumanStanding {
  flaggedShare: number;
  windows: number;
  percentile: { edge: number; above: boolean } | null;
}

type RowVerdict = "fail" | "pass" | "unmeasured" | "not-judged";

export interface WritingRow {
  metric: RegisterMetric;
  dimension: WritingDimension;
  value: number | null;
  band: Band;
  status: WritingStatus;
  verdict: RowVerdict;
  human: HumanStanding | null;
  spans: WritingSpan[];
}

export interface WritingReport {
  words: number;
  bucket: BucketName | null;
  humanReference: string;
  rows: WritingRow[];
  verdict: { pass: boolean; gateFails: number; warnings: number; reportOnly: number; gatesUnmeasured: number };
}

const outOfBand = (value: number, band: Band): boolean => (band.min !== undefined && value < band.min) || value > band.max;

function bucketFor(words: number): BucketName | null {
  return WRITING_BUCKETS.find((bucket) => bucket.name !== "full" && words >= bucket.lo && words <= bucket.hi)?.name ?? null;
}

const carriesRow = (metric: RegisterMetric, words: readonly string[]): boolean => (REGISTER_MEASURES[metric](spokenText([words.join(" ")])) ?? 0) > 0;

/** The shortest word run ending at the row's first hit at or after `from`. */
function firstRun(metric: RegisterMetric, words: readonly string[], from: number): { start: number; end: number } {
  let end = from + 1;
  while (end < words.length && !carriesRow(metric, words.slice(from, end))) end += 1;
  let start = end - 1;
  while (start > from && !carriesRow(metric, words.slice(start, end))) start -= 1;
  return { start, end };
}

/**
 * Narrows a beat to the word runs the row's own measure counts, so a span can never disagree with the row's value and
 * no row needs a second copy of its regex.
 */
function runsIn(metric: RegisterMetric, spoken: string): string[] {
  const words = spokenText([spoken]).text.split(" ");
  const runs: string[] = [];
  let from = 0;
  while (from < words.length && carriesRow(metric, words.slice(from))) {
    const { start, end } = firstRun(metric, words, from);
    runs.push(words.slice(start, end).join(" "));
    from = end;
  }
  return runs;
}

const bare = (run: string): string => (SEMICOLON_ONLY.test(run) ? run : run.replace(/^\W+|\W+$/g, ""));

function offendingSpans(metric: RegisterMetric, beats: readonly WritingBeat[]): WritingSpan[] {
  return beats.flatMap((beat) => runsIn(metric, beat.spoken).map((run) => ({ beat: beat.id, text: bare(run) }))).slice(0, MAX_SPANS);
}

function humanStanding(metric: RegisterMetric, value: number | null, check: WritingCheck, bucket: BucketName): HumanStanding | null {
  const { point, n } = check.rows[metric][bucket].fpr_heldout;
  if (point === null) return null;
  const band = REGISTER_BANDS[metric];
  const capped = band.min === undefined && value !== null;
  return { flaggedShare: point, windows: n, percentile: capped ? { edge: Math.round(100 * (1 - point)), above: value > band.max } : null };
}

function rowVerdict(status: WritingStatus, value: number | null, band: Band): RowVerdict {
  if (status !== "gate" && status !== "warning") return "not-judged";
  if (value === null) return "unmeasured";
  return outOfBand(value, band) ? "fail" : "pass";
}

function scoreRow([metric, dimension]: (typeof ROWS)[number], beats: readonly WritingBeat[], parsed: SpokenText, check: WritingCheck, bucket: BucketName | null): WritingRow {
  const value = REGISTER_MEASURES[metric](parsed) ?? null;
  const band = REGISTER_BANDS[metric];
  const status: WritingStatus = bucket === null ? "report-only" : check.statusByBucket[metric][bucket];
  const verdict = rowVerdict(status, value, band);
  const overCap = value !== null && value > band.max;
  const showSpans = verdict === "fail" && overCap && !SPANLESS.has(metric);
  return {
    metric, dimension, value, band, status, verdict,
    human: bucket === null ? null : humanStanding(metric, value, check, bucket),
    spans: showSpans ? offendingSpans(metric, beats) : [],
  };
}

function tally(rows: readonly WritingRow[]): WritingReport["verdict"] {
  const gateFails = rows.filter((row) => row.status === "gate" && row.verdict === "fail").length;
  return {
    pass: gateFails === 0,
    gateFails,
    warnings: rows.filter((row) => row.status === "warning" && row.verdict === "fail").length,
    reportOnly: rows.filter((row) => row.status === "report-only").length,
    gatesUnmeasured: rows.filter((row) => row.status === "gate" && row.verdict === "unmeasured").length,
  };
}

/** Scores a script's beats against the status table at the script's own length. Under 150 words every row is report-only. */
export function scoreWriting(beats: readonly WritingBeat[], check: WritingCheck): WritingReport {
  const parsed = spokenText(beats.map((beat) => beat.spoken));
  const words = parsed.words.length;
  const bucket = words < MIN_REGISTER_WORDS ? null : bucketFor(words);
  const rows = ROWS.map((row) => scoreRow(row, beats, parsed, check, bucket));
  return { words, bucket, humanReference: HUMAN_REFERENCE, rows, verdict: tally(rows) };
}
