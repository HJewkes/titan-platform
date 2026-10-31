import { isTaskId, meaningfulTerms, orExpression } from './terms.js';

/**
 * Turning trigger text into a query nobody had to write.
 *
 * TP-84 measured two ways of choosing terms from a long text and the rarest
 * terms by document frequency doubled spawn-arm recall@10 over the opening
 * words (0.203 against 0.103): briefs front-load boilerplate, so position is
 * the least discriminating signal there is. Pure; the frequency source is
 * injected so this is testable without an index.
 */

/** How many terms rarity picks. TP-84's measured value. */
export const QUERY_TERMS = 12;

/**
 * How common a term is in the corpus. Only its order matters, so a capped count
 * is fine, but it must be a count of matches: distinct owners among the top N
 * matching spans misranks common words as rare when their best spans sit in a
 * few long transcripts (measured 2026-09-16; see `document-frequency.ts`).
 */
export type DocumentFrequency = (term: string) => number;

export interface DerivedQuery {
  /** Rarest terms first, then every task id the text names. */
  terms: string[];
  /** FTS5 MATCH expression; empty when no term survived. */
  expression: string;
}

/**
 * Commit hashes read as the rarest terms in the corpus and would crowd out the
 * words a hash-heavy brief is actually about (TP-84 review).
 */
const HEX_HASH = /^[0-9a-f]{7,}$/;

function candidates(text: string): { terms: string[]; ids: string[] } {
  const distinct = meaningfulTerms(text);
  return {
    terms: distinct.filter((term) => !isTaskId(term) && !HEX_HASH.test(term)),
    ids: distinct.filter(isTaskId),
  };
}

/**
 * FTS5 computes bm25 for every span a query matches before a class filter can
 * apply, so a scoped query costs what its terms match across the whole corpus.
 * On a 2.36M-span graph, OR-ing words like `agent` (DF 495k) into a note query
 * took 25 bootstrap queries to 23.6 s; keeping only terms under ~1% of the
 * corpus took them to 1.5 s (TP-1960). Those common words carry almost no bm25
 * weight anyway, which is why dropping them leaves the ranking nearly intact.
 */
const DF_CAP_FRACTION = 0.01;

/** Below this many spans per term nothing is slow, so a small graph keeps every term. */
export const DF_CAP_FLOOR = 2000;

/** Fewer terms than this and a query is too narrow to rank; the rarest are kept over the cap. */
const MIN_TERMS = 3;

/** The most spans a query term may match, for a corpus of `spans` spans. */
export function documentFrequencyCap(spans: number): number {
  return Math.max(DF_CAP_FLOOR, Math.floor(spans * DF_CAP_FRACTION));
}

interface TermSelection {
  /** Most terms to keep. */
  limit?: number;
  /** Drop terms matching more spans than this, unless fewer than `MIN_TERMS` would remain. */
  maxDf?: number;
}

/** Ties keep first appearance, so the same text always derives the same query. */
function byRarity(terms: string[], counts: Map<string, number>): string[] {
  return terms
    .map((term, index) => ({ term, index }))
    .sort((a, b) => counts.get(a.term)! - counts.get(b.term)! || a.index - b.index)
    .map((entry) => entry.term);
}

/**
 * The rarest terms under the frequency cap, at most `limit` of them.
 *
 * When every term is common, the `MIN_TERMS` rarest are kept regardless: a
 * slower query beats an empty one, and the rarest common words still rank.
 */
export function selectTerms(
  terms: string[],
  df: DocumentFrequency,
  { limit = Number.POSITIVE_INFINITY, maxDf = Number.POSITIVE_INFINITY }: TermSelection = {},
): string[] {
  if (terms.length <= limit && maxDf === Number.POSITIVE_INFINITY) return terms;
  const counts = new Map(terms.map((term) => [term, df(term)]));
  const ordered = byRarity(terms, counts);
  const underCap = ordered.filter((term) => counts.get(term)! <= maxDf);
  const kept = underCap.length >= Math.min(MIN_TERMS, terms.length) ? underCap : ordered.slice(0, MIN_TERMS);
  return kept.slice(0, limit);
}

export function deriveQuery(
  text: string,
  df: DocumentFrequency,
  { limit = QUERY_TERMS, maxDf = Number.POSITIVE_INFINITY }: TermSelection = {},
): DerivedQuery {
  const { terms, ids } = candidates(text);
  // Ids are always kept: the `mentions` relation makes them exact hits.
  const picked = [...selectTerms(terms, df, { limit, maxDf }), ...ids];
  return { terms: picked, expression: orExpression(picked) };
}
