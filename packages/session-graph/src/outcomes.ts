import type { SessionGraph } from "./graph.js";

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
  /** Stored as the resolver counts it; the round definition is open question Q6 in the TP-256 design. */
  reviewRounds?: number | null;
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

/** A merge is final, so a merged PR is asked about once; open and closed PRs can still move. */
const PRS_NEEDING_OUTCOME = `
  SELECT pr_ref, repo, number FROM pr
  WHERE repo IS NOT NULL AND number IS NOT NULL AND (outcome_checked_at IS NULL OR state IS NOT 'merged')
  ORDER BY pr_ref`;

/** A stale forge cache must not reopen a PR a transcript saw merged, so `merged` is sticky. */
const APPLY_OUTCOME = `
  UPDATE pr SET
    state = CASE WHEN state = 'merged' THEN state ELSE COALESCE(lower(@state), state) END,
    merged_at = COALESCE(@mergedAt, merged_at),
    closed_at = COALESCE(@closedAt, closed_at),
    review_rounds = COALESCE(@reviewRounds, review_rounds),
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
  try {
    const resolved = await resolver(prs);
    return { requested: prs.length, applied: write(graph, resolved, new Date().toISOString()), failed: false };
  } catch (err) {
    return { requested: prs.length, applied: 0, failed: true, error: err instanceof Error ? err.message : String(err) };
  }
}

function write(graph: SessionGraph, resolved: PrResolution, checkedAt: string): number {
  const apply = graph.db.prepare(APPLY_OUTCOME);
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
        reviewRounds: fields.reviewRounds ?? null,
      }).changes;
    }
    return applied;
  })();
}
