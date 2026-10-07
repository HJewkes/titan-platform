import { REVIEW_TABLE } from "./audit-schema-v8.js";
import { callResolver } from "./enrich-result.js";
import type { SessionGraph } from "./graph.js";
import { countRounds } from "./review-rounds.js";

/** A PR the graph holds, as the resolver needs it to ask a forge. */
export interface PrKey {
  prRef: string;
  repo: string;
  number: number;
}

/**
 * What a forge knows and a transcript cannot state: a merge done by another
 * session or in the browser, a close, and the review history. Every field is
 * optional; an omitted or null field leaves whatever the transcripts derived.
 */
export interface ResolvedPr {
  /** `open`, `closed` or `merged`, in any case. */
  state?: string | null;
  mergedAt?: string | null;
  closedAt?: string | null;
  /** Stored as the forge's round count when `reviews` or `commitTimes` is absent; otherwise the round rule counts it. */
  reviewRounds?: number | null;
  /** The PR's commit times; an empty array is stored as known-empty, an omitted field leaves the stored value. */
  commitTimes?: readonly string[];
  /** Replaces the PR's stored forge reviews; an omitted field leaves them. */
  reviews?: readonly ResolvedReview[];
}

/** One forge review. `APPROVED` and `CHANGES_REQUESTED`, in any case, are stored; other states are ignored. */
export interface ResolvedReview {
  state: string;
  submittedAt: string;
}

/** Resolutions keyed by `pr_ref` (`pr:acme/demo#7`). */
export type PrResolution = ReadonlyMap<string, ResolvedPr | null | undefined>;

/**
 * Supplied by the caller, never by this package: session-graph is tier 2 and
 * must not learn which forge a product talks to. Called once per pass with every
 * PR whose outcome may still change.
 */
export type PrResolver = (prs: readonly PrKey[]) => PromiseLike<PrResolution> | PrResolution;

export interface PrEnrichment {
  /** PRs handed to the resolver. */
  requested: number;
  /** PR rows the resolver updated. */
  applied: number;
  /** The resolver threw; rows stand as the transcripts left them. */
  failed: boolean;
  /** Why it failed, for the caller to log. Absent unless `failed`. */
  error?: string;
}

export const NO_PR_OUTCOMES: PrEnrichment = Object.freeze({ requested: 0, applied: 0, failed: false });

/**
 * A merge is final, so a merged PR is asked about once commit times are known; open and closed PRs
 * can still move. Never-checked PRs lead and missing commit times trail, so a per-pass cap cannot starve open PRs.
 */
const PRS_NEEDING_OUTCOME = `
  SELECT pr_ref, repo, number FROM pr
  WHERE repo IS NOT NULL AND number IS NOT NULL
    AND (outcome_checked_at IS NULL OR state IS NOT 'merged' OR commit_times IS NULL)
  ORDER BY CASE WHEN outcome_checked_at IS NULL THEN 0 WHEN state IS NOT 'merged' THEN 1 ELSE 2 END, pr_ref`;

/** A stale forge cache must not reopen a PR a transcript saw merged, so `merged` is sticky. */
const APPLY_OUTCOME = `
  UPDATE pr SET
    state = CASE WHEN state = 'merged' THEN state ELSE COALESCE(lower(@state), state) END,
    merged_at = COALESCE(@mergedAt, merged_at),
    closed_at = COALESCE(@closedAt, closed_at),
    review_rounds = COALESCE(@reviewRounds, review_rounds),
    review_rounds_gh = COALESCE(@reviewRounds, review_rounds_gh),
    commit_times = COALESCE(@commitTimes, commit_times),
    outcome_checked_at = @checkedAt
  WHERE pr_ref = @prRef`;

export function prsNeedingOutcome(graph: SessionGraph): PrKey[] {
  const rows = graph.db.prepare(PRS_NEEDING_OUTCOME).all() as { pr_ref: string; repo: string; number: number }[];
  return rows.map((r) => ({ prRef: r.pr_ref, repo: r.repo, number: r.number }));
}

/**
 * Fill PR outcomes from a caller-supplied resolver. Runs after `reconcile`, so
 * it sees the merges the transcripts witnessed and only adds what they missed.
 * Updates rows and never inserts one: a PR enters the graph from a transcript.
 * A resolver that throws costs this pass its outcomes and nothing else.
 */
export async function enrichPrs(graph: SessionGraph, resolver: PrResolver | undefined): Promise<PrEnrichment> {
  if (!resolver) return NO_PR_OUTCOMES;
  const prs = prsNeedingOutcome(graph);
  if (prs.length === 0) return NO_PR_OUTCOMES;
  const outcome = await callResolver(prs.length, () => resolver(prs));
  if (!outcome.ok) return outcome.failure;
  return { requested: prs.length, applied: write(graph, outcome.value, new Date().toISOString()), failed: false };
}

function write(graph: SessionGraph, resolved: PrResolution, checkedAt: string): number {
  const apply = graph.db.prepare(APPLY_OUTCOME);
  const stored = graph.db.prepare("SELECT commit_times FROM pr WHERE pr_ref = ?");
  return graph.db.transaction(() => {
    let applied = 0;
    for (const [prRef, fields] of resolved) {
      if (!fields) continue;
      applied += apply.run({
        prRef,
        checkedAt,
        state: fields.state ?? null,
        mergedAt: fields.mergedAt ?? null,
        closedAt: fields.closedAt ?? null,
        reviewRounds: forgeRounds(fields, () => storedCommitTimes(stored.get(prRef))),
        commitTimes: fields.commitTimes ? JSON.stringify(fields.commitTimes) : null,
      }).changes;
      if (fields.reviews) replaceForgeReviews(graph, prRef, fields.reviews);
    }
    return applied;
  })();
}

const isChangesRequested = (review: ResolvedReview) => review.state.toUpperCase() === "CHANGES_REQUESTED";

/** Counts against sent commit times, else stored ones; unusable or absent times leave `reviewRounds` as sent. */
function forgeRounds(fields: ResolvedPr, storedTimes: () => string[] | null): number | null {
  if (!fields.reviews) return fields.reviewRounds ?? null;
  const commitTimes = fields.commitTimes ?? storedTimes();
  const counted = commitTimes ? countRounds(fields.reviews.filter(isChangesRequested).map((r) => r.submittedAt), commitTimes) : null;
  return counted ?? fields.reviewRounds ?? null;
}

function storedCommitTimes(row: unknown): string[] | null {
  const times = (row as { commit_times: string | null } | undefined)?.commit_times;
  return times ? (JSON.parse(times) as string[]) : null;
}

const FORGE_VERDICTS: Record<string, string> = { APPROVED: "approve", CHANGES_REQUESTED: "changes_requested" };

/** Two reviews in the same second share a key; a changes-requested one is kept over an approval. */
const INSERT_FORGE_REVIEW = `
  INSERT INTO ${REVIEW_TABLE} (source_key, surface, verdict, ts, repo, number, pr_ref)
  SELECT 'gh:' || pr_ref || ':' || @ts, 'github', @verdict, @ts, repo, number, pr_ref FROM pr WHERE pr_ref = @prRef
  ON CONFLICT (source_key) DO UPDATE SET verdict = CASE WHEN verdict = 'changes_requested' THEN verdict ELSE excluded.verdict END`;

function replaceForgeReviews(graph: SessionGraph, prRef: string, reviews: readonly ResolvedReview[]): void {
  graph.db.prepare(`DELETE FROM ${REVIEW_TABLE} WHERE surface = 'github' AND pr_ref = ?`).run(prRef);
  const insert = graph.db.prepare(INSERT_FORGE_REVIEW);
  for (const review of reviews) {
    const verdict = FORGE_VERDICTS[review.state.toUpperCase()];
    if (verdict) insert.run({ prRef, verdict, ts: review.submittedAt });
  }
}
