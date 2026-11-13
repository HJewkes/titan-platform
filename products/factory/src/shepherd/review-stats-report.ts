import type { Db } from "@titan-design/store-sqlite";
import { z } from "zod";
import { causeBucket, rereviewLines, rereviewOf, type Rereview } from "./review-stats-rereview.js";
import { median, p90 } from "./stage-times.js";
import { isoWeek } from "./stats.js";

/** Verdict days, inclusive, as YYYY-MM-DD in UTC; `repo` matches case-blind, as the store keeps repos lower case. */
interface ReviewRange {
  from?: string;
  to?: string;
  repo?: string;
  /** Epoch ms splitting fix rounds into before and after; absent means the first scoped round. */
  sinceScoped?: number;
}

interface Dist {
  p50: number | null;
  p90: number | null;
  mean: number | null;
  total: number;
}

interface Cut {
  n: number;
  unpriced: number;
  usd: Dist;
  tokens: Dist;
  reviewMinutes: Dist;
  queueMinutes: Dist;
}

interface PrRow {
  repo: string;
  pr: number;
  rounds: number;
  /** Rounds that returned MERGE or FIX_FIRST. */
  passes: number;
  usd: number | null;
  /** Passes at a head whose own diff equals the one at the run's previous verdict head, and what they cost. */
  unchangedPasses: number;
  unchangedUsd: number | null;
  reviewMinutes: number | null;
  queueMinutes: number | null;
  registeredToMergeMinutes: number | null;
  merged: boolean;
}

/** Passes that re-read an unchanged own diff, split by the verdict they followed, and the PRs with most of them. */
interface Unchanged {
  passes: number;
  usd: number;
  afterMerge: number;
  afterFixFirst: number;
  top: PrRow[];
}

/** A week's scoped fix rounds whose FIX_FIRST was checked, and the out-of-range and repeated items found in them. */
interface ScopeCheckWeek {
  checked: number;
  untagged: number;
  repeated: number;
}

interface ReviewReport {
  v: 1;
  at: string;
  range: { from: string | null; to: string | null; repo: string | null };
  perReview: Cut & { byRepo: Record<string, Cut>; byWeek: Record<string, Cut>; byModel: Record<string, Cut>; byVerdict: Record<string, number>; byCauseShape: Record<string, Cut> };
  perPr: { n: number; usd: Omit<Dist, "total">; reviewMinutes: Omit<Dist, "total">; rounds: Omit<Dist, "total">; passes: Dist; prs: PrRow[] };
  unchanged: Unchanged;
  rereview: Rereview;
  scopeCheckByWeek: Record<string, ScopeCheckWeek>;
  rows?: ReviewRecord[];
}

const ReviewSql = z.object({
  run_id: z.string(), round: z.number(), repo: z.string(), pr: z.number().nullable(), head_sha: z.string().nullable(), reviewer: z.string().nullable(),
  session_id: z.string().nullable(), model: z.string().nullable(), requested_at: z.number(), started_at: z.number().nullable(), verdict_at: z.number().nullable(),
  queue_ms: z.number().nullable(), review_ms: z.number().nullable(), verdict: z.string().nullable(), usd: z.number().nullable(), cost_source: z.string().nullable(),
  input: z.number().nullable(), cache_read: z.number().nullable(), cache_write: z.number().nullable(), output: z.number().nullable(),
  cause: z.string().nullable(), shape: z.string().nullable(), scoped: z.number().nullable(), scope_untagged: z.number().nullable(), scope_repeated: z.number().nullable(),
  own_diff_id: z.string().nullable(), unchanged_since_verdict: z.string().nullable(),
});
type ReviewSqlRow = z.infer<typeof ReviewSql>;

const PrSql = z.object({
  repo: z.string(), pr: z.number(), rounds: z.number(), usd: z.number().nullable(), review_ms: z.number().nullable(), queue_ms: z.number().nullable(),
  registered_at: z.number().nullable(), merged_at: z.number().nullable(), passes: z.number(), unchanged_passes: z.number(), unchanged_usd: z.number().nullable(),
});

interface ReviewRecord {
  runId: string;
  round: number;
  repo: string;
  pr: number | null;
  headSha: string | null;
  reviewer: string | null;
  sessionId: string | null;
  model: string | null;
  requestedAt: string;
  startedAt: string | null;
  verdictAt: string | null;
  queueMinutes: number | null;
  reviewMinutes: number | null;
  verdict: string | null;
  usd: number | null;
  costSource: string | null;
  cause: string | null;
  shape: string | null;
  scoped: boolean | null;
  ownDiffId: string | null;
  unchangedSinceVerdict: string | null;
}

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
/** A round with no verdict time still counts, on the day it was requested. */
const REVIEW_DAY = "COALESCE(verdict_at, requested_at)";
const roundTo = (digits: number) => (value: number): number => Math.round(value * 10 ** digits) / 10 ** digits;
const money = roundTo(6);
const tenth = roundTo(1);
const toMinutes = (ms: number | null): number | null => (ms === null ? null : tenth(ms / MINUTE_MS));
const isoOf = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

/** The WHERE clause and its parameters; `to` is inclusive, so the bound is the start of the next day. */
function filterOf(range: ReviewRange): { where: string; params: Record<string, string | number> } {
  const bounds: [string, string, string | number | undefined][] = [
    ["from", `${REVIEW_DAY} >= @from`, range.from === undefined ? undefined : Date.parse(`${range.from}T00:00:00Z`)],
    ["to", `${REVIEW_DAY} < @to`, range.to === undefined ? undefined : Date.parse(`${range.to}T00:00:00Z`) + DAY_MS],
    ["repo", "repo = @repo", range.repo?.toLowerCase()],
  ];
  const set = bounds.filter((bound): bound is [string, string, string | number] => bound[2] !== undefined);
  return { where: ["1 = 1", ...set.map(([, clause]) => clause)].join(" AND "), params: Object.fromEntries(set.map(([name, , value]) => [name, value])) };
}

function dist(values: readonly (number | null)[], scale: (value: number) => number): Dist {
  const sorted = values.filter((value): value is number => value !== null).sort((a, b) => a - b);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  if (sorted.length === 0) return { p50: null, p90: null, mean: null, total: 0 };
  return { p50: scale(median(sorted)), p90: scale(p90(sorted)), mean: scale(total / sorted.length), total: scale(total) };
}

/** Every token the round billed; null when it was never priced. */
const tokensOf = (row: ReviewSqlRow): number | null => (row.input === null ? null : row.input + (row.cache_read ?? 0) + (row.cache_write ?? 0) + (row.output ?? 0));

function cut(rows: readonly ReviewSqlRow[]): Cut {
  return {
    n: rows.length,
    unpriced: rows.filter((row) => row.usd === null).length,
    usd: dist(rows.map((row) => row.usd), money),
    tokens: dist(rows.map(tokensOf), Math.round),
    reviewMinutes: dist(rows.map((row) => row.review_ms), (ms) => tenth(ms / MINUTE_MS)),
    queueMinutes: dist(rows.map((row) => row.queue_ms), (ms) => tenth(ms / MINUTE_MS)),
  };
}

function cutsBy(rows: readonly ReviewSqlRow[], key: (row: ReviewSqlRow) => string): Record<string, Cut> {
  const groups = new Map<string, ReviewSqlRow[]>();
  for (const row of rows) groups.set(key(row), [...(groups.get(key(row)) ?? []), row]);
  return Object.fromEntries([...groups].sort(([a], [b]) => a.localeCompare(b)).map(([name, group]) => [name, cut(group)]));
}

function countBy(rows: readonly ReviewSqlRow[], key: (row: ReviewSqlRow) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) counts[key(row)] = (counts[key(row)] ?? 0) + 1;
  return counts;
}

/** Per-PR totals are sums over the PR's rounds in range; the run's registration and merge come from `review_run`. */
function prRows(db: Db, range: ReviewRange): PrRow[] {
  const { where, params } = filterOf(range);
  const sql = `SELECT r.repo, r.pr, COUNT(*) AS rounds, SUM(r.usd) AS usd, SUM(r.review_ms) AS review_ms, SUM(r.queue_ms) AS queue_ms,
      COUNT(CASE WHEN r.verdict IN ('MERGE', 'FIX_FIRST') THEN 1 END) AS passes,
      COUNT(CASE WHEN r.unchanged_since_verdict LIKE 'after-%' THEN 1 END) AS unchanged_passes,
      SUM(CASE WHEN r.unchanged_since_verdict LIKE 'after-%' THEN r.usd END) AS unchanged_usd,
      (SELECT MIN(registered_at) FROM review_run AS run WHERE run.repo = r.repo AND run.pr = r.pr) AS registered_at,
      (SELECT MAX(merged_at) FROM review_run AS run WHERE run.repo = r.repo AND run.pr = r.pr) AS merged_at
    FROM (SELECT * FROM review WHERE ${where}) AS r WHERE r.pr IS NOT NULL GROUP BY r.repo, r.pr ORDER BY usd DESC, r.repo, r.pr`;
  return z.array(PrSql).parse(db.prepare(sql).all(params)).map((row) => ({
    repo: row.repo, pr: row.pr, rounds: row.rounds, passes: row.passes, usd: row.usd === null ? null : money(row.usd),
    unchangedPasses: row.unchanged_passes, unchangedUsd: row.unchanged_usd === null ? null : money(row.unchanged_usd), reviewMinutes: toMinutes(row.review_ms), queueMinutes: toMinutes(row.queue_ms),
    registeredToMergeMinutes: row.merged_at === null || row.registered_at === null ? null : toMinutes(row.merged_at - row.registered_at), merged: row.merged_at !== null,
  }));
}

const record = (row: ReviewSqlRow): ReviewRecord => ({
  runId: row.run_id, round: row.round, repo: row.repo, pr: row.pr, headSha: row.head_sha, reviewer: row.reviewer, sessionId: row.session_id, model: row.model,
  requestedAt: isoOf(row.requested_at)!, startedAt: isoOf(row.started_at), verdictAt: isoOf(row.verdict_at), queueMinutes: toMinutes(row.queue_ms),
  reviewMinutes: toMinutes(row.review_ms), verdict: row.verdict, usd: row.usd, costSource: row.cost_source, cause: row.cause, shape: row.shape,
  scoped: row.scoped === null ? null : row.scoped === 1, ownDiffId: row.own_diff_id, unchangedSinceVerdict: row.unchanged_since_verdict,
});

const rereviewInput = (row: ReviewSqlRow) => ({ cause: row.cause, shape: row.shape, scoped: row.scoped, at: row.verdict_at ?? row.requested_at, usd: row.usd, tokens: tokensOf(row) });

function scopeCheckByWeek(rows: readonly ReviewSqlRow[]): Record<string, ScopeCheckWeek> {
  const weeks: Record<string, ScopeCheckWeek> = {};
  for (const row of rows.filter((each) => each.scope_untagged !== null || each.scope_repeated !== null)) {
    const week = (weeks[isoWeek(row.verdict_at ?? row.requested_at)] ??= { checked: 0, untagged: 0, repeated: 0 });
    Object.assign(week, { checked: week.checked + 1, untagged: week.untagged + (row.scope_untagged ?? 0), repeated: week.repeated + (row.scope_repeated ?? 0) });
  }
  return weeks;
}

const scopeCheckLines = (weeks: Record<string, ScopeCheckWeek>): string[] => {
  const lines = Object.entries(weeks).map(([week, c]) => `  ${week}  checked ${c.checked}  untagged ${c.untagged}  repeated ${c.repeated}`);
  return lines.length === 0 ? [] : ["scope checks by week:", ...lines];
};

/** Totals are re-countable from the rows: each unchanged pass is one row labelled `after-MERGE` or `after-FIX_FIRST`. */
function unchangedOf(rows: readonly ReviewSqlRow[], prs: readonly PrRow[]): Unchanged {
  const labelled = rows.filter((row) => row.unchanged_since_verdict?.startsWith("after-"));
  const top = prs.filter((pr) => pr.unchangedPasses > 0).sort((a, b) => b.unchangedPasses - a.unchangedPasses || (b.unchangedUsd ?? 0) - (a.unchangedUsd ?? 0) || a.pr - b.pr);
  return {
    passes: labelled.length,
    usd: money(labelled.reduce((sum, row) => sum + (row.usd ?? 0), 0)),
    afterMerge: labelled.filter((row) => row.unchanged_since_verdict === "after-MERGE").length,
    afterFixFirst: labelled.filter((row) => row.unchanged_since_verdict === "after-FIX_FIRST").length,
    top: top.slice(0, 10),
  };
}

const spread = ({ p50, p90: high, mean }: Dist): Omit<Dist, "total"> => ({ p50, p90: high, mean });

/** The v1 console-ready read of the review store: per-review distributions with their cuts, and per-PR totals. */
export function reviewReport(db: Db, range: ReviewRange, now: number, withRows = false): ReviewReport {
  const { where, params } = filterOf(range);
  const rows = z.array(ReviewSql).parse(db.prepare(`SELECT * FROM review WHERE ${where} ORDER BY ${REVIEW_DAY}, run_id, round`).all(params));
  const prs = prRows(db, range);
  const perReview = {
    ...cut(rows),
    byRepo: cutsBy(rows, (row) => row.repo),
    byWeek: cutsBy(rows, (row) => isoWeek(row.verdict_at ?? row.requested_at)),
    byModel: cutsBy(rows, (row) => row.model ?? "unknown"),
    byVerdict: countBy(rows, (row) => row.verdict ?? "none"),
    byCauseShape: cutsBy(rows, (row) => `${row.shape ?? "unknown"} ${causeBucket(row.cause)}`),
  };
  const perPr = {
    n: prs.length,
    usd: spread(dist(prs.map((pr) => pr.usd), money)),
    reviewMinutes: spread(dist(prs.map((pr) => pr.reviewMinutes), tenth)),
    rounds: spread(dist(prs.map((pr) => pr.rounds), tenth)),
    passes: dist(prs.map((pr) => pr.passes), tenth),
    prs,
  };
  const echoed = { from: range.from ?? null, to: range.to ?? null, repo: range.repo?.toLowerCase() ?? null };
  const rereview = rereviewOf(rows.map(rereviewInput), range.sinceScoped);
  const report: ReviewReport = { v: 1, at: new Date(now).toISOString(), range: echoed, perReview, perPr, unchanged: unchangedOf(rows, prs), rereview, scopeCheckByWeek: scopeCheckByWeek(rows) };
  return withRows ? { ...report, rows: rows.map(record) } : report;
}

const usdText = (value: number | null): string => (value === null ? "-" : `$${value.toFixed(2)}`);
const minText = (value: number | null): string => (value === null ? "-" : `${value}m`);
const distLine = (label: string, d: Dist, text: (value: number | null) => string): string =>
  `  ${label.padEnd(10)} p50 ${text(d.p50)}  p90 ${text(d.p90)}  mean ${text(d.mean)}  total ${text(d.total)}`;

function cutLines(title: string, cuts: Record<string, Cut>): string[] {
  const lines = Object.entries(cuts).map(([name, c]) => {
    const usd = `usd p50 ${usdText(c.usd.p50)} p90 ${usdText(c.usd.p90)} total ${usdText(c.usd.total)}`;
    return `  ${name}  reviews ${c.n}  ${usd}  tokens p50 ${c.tokens.p50 ?? "-"} p90 ${c.tokens.p90 ?? "-"}  review p50 ${minText(c.reviewMinutes.p50)} p90 ${minText(c.reviewMinutes.p90)}`;
  });
  return lines.length === 0 ? [] : [`${title}:`, ...lines];
}

const prLine = (pr: PrRow): string => {
  const merged = pr.merged ? `merged after ${minText(pr.registeredToMergeMinutes)}` : "not merged";
  return `  ${pr.repo}#${pr.pr}  rounds ${pr.rounds}  passes ${pr.passes}  ${usdText(pr.usd)}  unchanged ${pr.unchangedPasses} ${usdText(pr.unchangedUsd)}  review ${minText(pr.reviewMinutes)}  queue ${minText(pr.queueMinutes)}  ${merged}`;
};

const passesLine = (passes: Dist, unchanged: Unchanged): string =>
  `passes ${passes.total}  per PR p50 ${passes.p50 ?? "-"} mean ${passes.mean ?? "-"} p90 ${passes.p90 ?? "-"}  unchanged ${unchanged.passes} ${usdText(unchanged.usd)} (after MERGE ${unchanged.afterMerge}, after FIX_FIRST ${unchanged.afterFixFirst})`;

/** Text mode: the per-review distribution, its cuts, per-PR passes with their unchanged share, and the top ten PRs by cost and by unchanged passes. */
export function formatReviewReport(report: ReviewReport): string {
  const r = report.perReview;
  if (r.n === 0) return "no reviews in range\n";
  const verdicts = Object.entries(r.byVerdict).map(([verdict, n]) => `${verdict} ${n}`).join("  ");
  const lines = [
    `reviews ${r.n}  unpriced ${r.unpriced}  verdicts ${verdicts}`,
    distLine("usd", r.usd, usdText), distLine("review", r.reviewMinutes, minText), distLine("queue", r.queueMinutes, minText),
    ...cutLines("by repo", r.byRepo), ...cutLines("by week", r.byWeek), ...cutLines("by model", r.byModel), ...cutLines("by shape and cause", r.byCauseShape),
    ...rereviewLines(report.rereview),
    ...scopeCheckLines(report.scopeCheckByWeek),
    `PRs ${report.perPr.n}  usd p50 ${usdText(report.perPr.usd.p50)} p90 ${usdText(report.perPr.usd.p90)}  rounds p50 ${report.perPr.rounds.p50 ?? "-"} p90 ${report.perPr.rounds.p90 ?? "-"}`,
    passesLine(report.perPr.passes, report.unchanged),
    "top 10 PRs by review cost:", ...report.perPr.prs.slice(0, 10).map(prLine),
    ...(report.unchanged.top.length === 0 ? [] : ["top 10 PRs by unchanged passes:", ...report.unchanged.top.map(prLine)]),
  ];
  return `${lines.join("\n")}\n`;
}
