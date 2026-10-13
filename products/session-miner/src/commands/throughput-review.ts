import { existsSync, readFileSync } from "node:fs";
import { EXIT, defineCommand } from "@titan-design/registry";
import type { TaskActualsOptions } from "@titan-design/session-analytics";
import {
  NO_PR_KEY,
  REVIEW_TARGETS,
  reviewAblation,
  reviewFeatureKey,
  reviewFor,
  reviewTable,
  type ReviewAblationResult,
  type ReviewArmScore,
  type ReviewFacts,
  type ReviewTable,
  type ReviewTargetAblation,
  type ThroughputRow,
} from "@titan-design/throughput";
import { z } from "zod";
import type { MinerContext } from "../context.js";
import { isoTime } from "../insights/define.js";
import { coverage, DEFAULT_HORIZON_DAYS, DEFAULT_WEEKS, FIT_OPTIONS, FitArgs, loadRows, renderInputs, weeklyOrigins, type ThroughputInputs } from "./throughput.js";
import { prDiffCachePath, readPrDiffCache } from "./throughput-pr-backfill.js";

type ShepherdRunRecord = NonNullable<TaskActualsOptions["shepherdRuns"]>[number];

const ReviewArgs = z
  .object({
    ...FitArgs,
    origin: z.array(isoTime).optional().describe("origin date to refit at (repeatable); overrides --weeks"),
    weeks: z.number().int().positive().optional().describe("weekly origins ending one horizon before the newest done task (default 4)"),
    horizon: z.number().positive().optional().describe("days after each origin to score (default 7)"),
    shepherdRuns: z.string().optional().describe("`titan-factory shepherd stats --per-run --json` output; without it review rounds and post-PR hours are unknown"),
  })
  .strict();
type ReviewArgs = z.infer<typeof ReviewArgs>;

/** Rows with a merged PR, and how many of them the PR diff cache covered. */
interface CacheCoverage {
  withPrs: number;
  featured: number;
}

interface ThroughputReviewResult extends ThroughputInputs {
  cachePath: string;
  cacheCoverage: CacheCoverage;
  /** Shepherd runs joined onto the rows; null when no `--shepherd-runs` file was given. */
  shepherdRuns: number | null;
  table: ReviewTable;
  ablation: ReviewAblationResult;
}

const StageMinutes = z.partialRecord(z.enum(["queued", "ci", "review", "re-review", "hold", "land"]), z.number());
const ShepherdRun = z.object({
  runId: z.string(),
  task: z.string().nullable(),
  repo: z.string(),
  pr: z.number().int().nullable(),
  kind: z.string(),
  status: z.string(),
  startedAt: z.string(),
  completedAt: z.string().nullable(),
  stageMinutes: StageMinutes,
  reviewRounds: z.number(),
  mergedAt: z.string().nullable(),
  mergePath: z.enum(["shepherd", "outside"]).nullable(),
});
const ShepherdStats = z.object({ perRun: z.array(ShepherdRun) });

export function readShepherdRuns(file: string): ShepherdRunRecord[] {
  if (!existsSync(file)) throw Object.assign(new Error(`no Shepherd runs file at ${file}`), { code: EXIT.NOINPUT });
  const parsed = ShepherdStats.safeParse(JSON.parse(readFileSync(file, "utf8")));
  if (!parsed.success) throw Object.assign(new Error(`invalid Shepherd runs file ${file}: ${z.prettifyError(parsed.error)}`), { code: EXIT.DATAERR });
  return parsed.data.perRun;
}

/** `prClass` is set only from a cache hit; `pr-diff-missing` marks a merged PR the cache lacked. */
function cacheCoverage(rows: readonly ThroughputRow[]): CacheCoverage {
  const featured = rows.filter((row) => row.prClass != null).length;
  const missing = rows.filter((row) => row.flags?.includes("pr-diff-missing")).length;
  return { withPrs: featured + missing, featured };
}

function placeable(rows: readonly ThroughputRow[]): boolean {
  return rows.some((row) => !row.flags?.includes("no-impl-session") && reviewFeatureKey(row) !== undefined);
}

export const throughputReview = defineCommand<ReviewArgs, ThroughputReviewResult | string, MinerContext>({
  name: "throughput.review",
  description: "Review-time table keyed on review-panel class x lead touch, and its rolling-origin ablation against kind x size band",
  args: ReviewArgs,
  result: z.union([z.custom<ThroughputReviewResult>(), z.string()]),
  cli: {
    options: {
      ...FIT_OPTIONS,
      origin: { long: "--origin", description: "ISO origin date (repeatable)" },
      weeks: { long: "--weeks", description: "weekly origins to score (default 4)" },
      horizon: { long: "--horizon", description: "days scored after each origin (default 7)" },
      shepherdRuns: { long: "--shepherd-runs", description: "file holding `titan-factory shepherd stats --per-run --json`" },
    },
  },
  async run(args, ctx) {
    const result = review(args, ctx);
    return ctx.format === "human" ? renderReview(result).join("\n") : result;
  },
});

function review(args: ReviewArgs, ctx: MinerContext): ThroughputReviewResult {
  const cachePath = prDiffCachePath(ctx.config.stateDir);
  const shepherdRuns = args.shepherdRuns === undefined ? undefined : readShepherdRuns(args.shepherdRuns);
  const loaded = loadRows(ctx, args.cap, { prDiffs: readPrDiffCache(cachePath), shepherdRuns });
  if (!placeable(loaded.rows)) throw Object.assign(new Error(`no row carries PR features; run throughput pr-backfill to fill ${cachePath}`), { code: EXIT.DATAERR });
  const config = { halfLifeDays: args.halfLife, minN: args.minN, minerIndexedAt: loaded.minerIndexedAt ?? undefined };
  const table = reviewTable(loaded.rows, { ...config, asOf: args.asOf, key: "diff" });
  const horizonDays = args.horizon ?? DEFAULT_HORIZON_DAYS;
  const origins = args.origin ?? weeklyOrigins(table.watermark.newestDoneAt, horizonDays, args.weeks ?? DEFAULT_WEEKS);
  const ablation = reviewAblation(loaded.rows, { origins, horizonDays, config });
  const inputs = { modelHash: table.modelHash, watermark: table.watermark, excludedRows: table.excludedRows, ...loaded.inputs };
  return { ...inputs, cachePath, cacheCoverage: cacheCoverage(loaded.rows), shepherdRuns: shepherdRuns?.length ?? null, table, ablation };
}

function renderReview(result: ThroughputReviewResult): string[] {
  const { cacheCoverage: c, shepherdRuns, table, ablation } = result;
  const share = c.withPrs === 0 ? "" : ` ${((c.featured / c.withPrs) * 100).toFixed(0)}%`;
  const header = `cache coverage ${c.featured}/${c.withPrs}${share}  missingFeatures ${table.skippedMissingFeatures}  shepherdRuns ${shepherdRuns ?? "none"}`;
  return [renderInputs(result), header, "", "review table (diff key)", ...renderTable(table), "", `ablation horizon ${ablation.horizonDays}d`, ...renderAblation(ablation)];
}

/** Rebuilds the facts a diff key came from, so each key's back-off is the package's own. */
function factsOf(key: string): ReviewFacts {
  if (key === NO_PR_KEY) return { prClass: null, touches: [] };
  const [prClass, touch] = key.split("/");
  return { prClass, touches: touch === "none" ? [] : [touch!] };
}

function renderTable(table: ReviewTable): string[] {
  const keys = [...new Set(REVIEW_TARGETS.flatMap((target) => Object.keys(table.targets[target].keys)))].sort();
  return keys.map((key) => {
    const cells = REVIEW_TARGETS.map((target) => {
      const n = table.targets[target].keys[key]?.n ?? 0;
      const entry = reviewFor(table, factsOf(key), target);
      if (!entry) return `${target} -`;
      return `${target} n ${n} from ${entry.level}:${entry.levelKey} p50 ${entry.quantiles.p50.toFixed(2)} p90 ${entry.quantiles.p90.toFixed(2)}`;
    });
    return `${key}  ${cells.join("  ")}`;
  });
}

function renderAblation(ablation: ReviewAblationResult): string[] {
  const skipped = `excluded ${ablation.excludedRows}  missingFeatures ${ablation.skippedMissingFeatures}  noStart ${ablation.skippedNoStart}`;
  const origins = ablation.origins.map((o) => `origin ${o.origin.slice(0, 10)}  train ${o.trainN}  test ${o.testN}`);
  const targets = REVIEW_TARGETS.map((target) => renderTargetAblation(target, ablation.pooled[target]));
  return [skipped, ...origins, ...targets];
}

function renderTargetAblation(target: string, t: ReviewTargetAblation): string {
  const verdict = t.insufficient ? "insufficient" : `deltaP50 ${num(t.deltaP50)}`;
  return `${target}  n ${t.n} skippedNull ${t.skippedNull} unscored ${t.unscored}  ${verdict}  diff ${armLine(t.diff)}  base ${armLine(t.base)}`;
}

function armLine(arm: ReviewArmScore): string {
  return `pinball p10 ${num(arm.pinball.p10)} p50 ${num(arm.pinball.p50)} p90 ${num(arm.pinball.p90)} 80% ${coverage(arm.coverage)}`;
}

function num(value: number | null): string {
  return value === null ? "-" : value.toFixed(3);
}
