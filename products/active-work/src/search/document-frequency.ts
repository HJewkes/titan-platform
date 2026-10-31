import type { WorkspaceGraph } from '../session-index/graph.js';
import { documentFrequencyCap, type DocumentFrequency } from './derive-query.js';
import { orExpression } from './terms.js';

/**
 * Document frequency off the span index, cheap enough to ask for every term.
 *
 * Two sources, because neither is right alone. FTS5's vocabulary table reads a
 * term's doc count straight off its posting list (21 ms for a term in 495k
 * spans), but a contentless table keeps a purged span's row, so that count is
 * an upper bound. Counting matches joined to the span table is exact but costs
 * a row per match. So the vocabulary answers for common terms, where the exact
 * count does not matter, and the join answers for rare ones, where it does.
 *
 * Distinct owners among the first N spans was tried before either and
 * misranked: a common word whose best spans sit in a few long transcripts
 * counted as rare, picking `work` and `active` over `introspection`.
 */
const SPAN_CAP = 2000;

interface DatabaseCounts {
  terms: Map<string, number>;
  spans?: number;
}

/** Per database file, for the life of the process; the daemon keeps one graph open. */
const cache = new Map<string, DatabaseCounts>();

/** Bounded so a long-lived daemon cannot grow the cache without limit. */
const CACHE_TERMS = 20_000;

/**
 * Both span indexes: the frequency of a term is corpus-wide, whichever table a
 * query then ranks. `spans.search` reads these too, but ranks every match first.
 */
const SPAN_INDEXES = [
  { span: 'search_span', fts: 'search_fts' },
  { span: 'workspace_span', fts: 'workspace_fts' },
] as const;

type SpanIndex = (typeof SPAN_INDEXES)[number];

/** Drop the cached counts for one database; a pass that indexed spans has made them stale. */
export function clearDocumentFrequency(dbName: string): void {
  cache.delete(dbName);
}

function countsFor(graph: WorkspaceGraph): DatabaseCounts {
  const key = graph.db.name;
  const known = cache.get(key);
  if (known) return known;
  const fresh: DatabaseCounts = { terms: new Map() };
  cache.set(key, fresh);
  return fresh;
}

/**
 * min(matches, cap) without bm25 ordering: the count never needs a rank.
 *
 * Joined to the span table because a purged span strands its contentless FTS
 * row; counting the FTS table alone would keep a deleted span in the count.
 */
export function countMatches(graph: WorkspaceGraph, expression: string, cap: number): number {
  const count = ({ span, fts }: SpanIndex): number =>
    graph.db
      .prepare<[string, number], { n: number }>(
        `SELECT count(*) AS n FROM (
          SELECT ${fts}.rowid FROM ${fts}
          JOIN ${span} ON ${span}.span_id = ${fts}.rowid
          WHERE ${fts} MATCH ? LIMIT ?)`,
      )
      .get(expression, cap)?.n ?? 0;
  return Math.min(cap, SPAN_INDEXES.reduce((total, index) => total + count(index), 0));
}

/** The tokens FTS5's default unicode61 tokenizer makes of a term: diacritics off, split on the rest. */
export function ftsTokens(term: string): string[] {
  const folded = term.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  return folded.match(/[\p{L}\p{N}]+/gu) ?? [];
}

/**
 * A phrase matches no more spans than its rarest token, so that token bounds it.
 * The vocabulary table is per connection, in `temp`, so a read-only graph can
 * still have one.
 */
function vocabularyBound(graph: WorkspaceGraph, term: string): number {
  const tokens = ftsTokens(term);
  if (tokens.length === 0) return 0;
  const bound = ({ fts }: SpanIndex): number => {
    const vocab = `temp.${fts}_vocab`;
    graph.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${vocab} USING fts5vocab(main, ${fts}, row)`);
    const lookup = graph.db.prepare<[string], { doc: number }>(`SELECT doc FROM ${vocab} WHERE term = ?`);
    return Math.min(...tokens.map((token) => lookup.get(token)?.doc ?? 0));
  };
  return SPAN_INDEXES.reduce((total, index) => total + bound(index), 0);
}

function countSpans(graph: WorkspaceGraph, term: string): number {
  const bound = vocabularyBound(graph, term);
  return bound > SPAN_CAP ? bound : countMatches(graph, orExpression([term]), SPAN_CAP);
}

export function graphDocumentFrequency(graph: WorkspaceGraph): DocumentFrequency {
  return (term) => {
    const counts = countsFor(graph).terms;
    const known = counts.get(term);
    if (known !== undefined) return known;
    if (counts.size >= CACHE_TERMS) counts.clear();
    const count = countSpans(graph, term);
    counts.set(term, count);
    return count;
  };
}

/**
 * How many spans the index holds, as its highest span id.
 *
 * Ids are never reused, so this counts purged spans too, the same way the
 * vocabulary's doc counts do; `count(*)` would read the whole table (0.36 s).
 */
function corpusSpans(graph: WorkspaceGraph): number {
  const counts = countsFor(graph);
  if (counts.spans === undefined) {
    const row = graph.db
      .prepare<[], { n: number | null }>(
        `SELECT coalesce((SELECT max(span_id) FROM search_span), 0)
              + coalesce((SELECT max(span_id) FROM workspace_span), 0) AS n`,
      )
      .get();
    counts.spans = row?.n ?? 0;
  }
  return counts.spans;
}

interface TermStatistics {
  df: DocumentFrequency;
  /** The most spans a query term may match on this graph. */
  maxDf: number;
}

export function graphTermStatistics(graph: WorkspaceGraph): TermStatistics {
  return { df: graphDocumentFrequency(graph), maxDf: documentFrequencyCap(corpusSpans(graph)) };
}
