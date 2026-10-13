import { changedLineCount, classifyPr, DEFAULT_CLASS_RULES, type ChangedFile, type ClassRules, type PrTouch, type ReviewClass } from "@titan-design/review-panel";
import type { Db } from "@titan-design/store-sqlite";

/** One merged PR's changed files as the gh backfill cached them; no diff text is kept. */
export interface PrDiff {
  /** `pr:<owner/repo>#<n>`, the miner's spelling. */
  prRef: string;
  repo: string;
  pr: number;
  head: string;
  files: ChangedFile[];
  /** GitHub returned fewer files than the PR changed (its 3,000-file cap), so the line count is short. */
  truncated: boolean;
}

/** The review-panel features of every PR a task merged, taken together. Null means unknown, not zero. */
export interface PrFeatures {
  prClass: ReviewClass | null;
  touches: PrTouch[] | null;
  changedLines: number | null;
}

/** What `prFeaturesFor` reads from a row. */
interface PrFeatureRow {
  prs: readonly { prRef: string; mergedAt: string | null }[];
}

const PR_REF = /^pr:([^#]+)#(\d+)$/;

/** The inverse of session-read's `prRef`; undefined for any other spelling. */
export function parsePrRef(ref: string): { repo: string; pr: number } | undefined {
  const match = PR_REF.exec(ref);
  return match ? { repo: match[1]!, pr: Number(match[2]) } : undefined;
}

const NO_PR: PrFeatures = { prClass: null, touches: [], changedLines: 0 };
const UNKNOWN: PrFeatures = { prClass: null, touches: null, changedLines: null };

/** Counts dropped so review-panel falls back to its file-count rule rather than reading a short line sum as small. */
const withoutCounts = (files: readonly ChangedFile[]): ChangedFile[] => files.map((f) => ({ ...f, additions: Number.NaN, deletions: Number.NaN }));

/**
 * Classifies all of a task's merged PRs as one change, so the `large` threshold and touch order stay
 * review-panel's. `missing` is set when a merged PR has no cache entry: a partial diff would read short.
 */
export function prFeaturesFor(row: PrFeatureRow, kind: string | null | undefined, diffs: ReadonlyMap<string, PrDiff>, rules: ClassRules = DEFAULT_CLASS_RULES): PrFeatures & { missing: boolean } {
  const merged = row.prs.filter((p) => p.mergedAt !== null);
  if (merged.length === 0) return { ...NO_PR, missing: false };
  const prDiffs = merged.flatMap((p) => diffs.get(p.prRef) ?? []);
  if (prDiffs.length < merged.length) return { ...UNKNOWN, missing: true };
  const truncated = prDiffs.some((d) => d.truncated);
  const files = prDiffs.flatMap((d) => d.files);
  const first = prDiffs[0]!;
  const changedFiles = truncated ? withoutCounts(files) : files;
  const pr = classifyPr({ repo: first.repo, pr: first.pr, head: first.head, base: "", changedFiles, ...(typeof kind === "string" && { kind }) }, rules);
  const changedLines = truncated ? null : (changedLineCount(files, rules) ?? null);
  return { prClass: pr.class, touches: [...pr.touches], changedLines, missing: false };
}

/** Every merged PR ref in the miner index, sorted; `since` keeps those merged at or after it. */
export function listMergedPrRefs(db: Db, since?: string): string[] {
  const rows = db
    .prepare("SELECT pr_ref AS prRef FROM pr WHERE merged_at IS NOT NULL AND (@since IS NULL OR merged_at >= @since) ORDER BY pr_ref")
    .all({ since: since ?? null });
  return rows.map((row) => (row as { prRef: string }).prRef);
}
