import { documentFrequencyCap, orExpression, type DocumentFrequency } from '@titan-design/retrieval';
import type { WorkspaceGraph } from '../session-index/graph.js';
import {
  indexStamp,
  readStoredCounts,
  removeStoredCounts,
  writeStoredCounts,
} from './document-frequency-store.js';
import { hasLegacyWorkspaceSpans } from './workspace-spans.js';

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
  spans: number;
  /** Absent when the graph has no file to stamp; such counts stay in memory. */
  stamp?: string;
  /** Holds counts this process looked up that the store does not have yet. */
  dirty: boolean;
}

/** Per database file, for the life of the process; the daemon keeps one graph open. */
const cache = new Map<string, DatabaseCounts>();

/** Bounded so a long-lived daemon cannot grow the cache without limit. */
const CACHE_TERMS = 20_000;

/** How long a daemon batches new counts before persisting them; a CLI persists on exit. */
const PERSIST_DELAY_MS = 1000;
let persistTimer: NodeJS.Timeout | undefined;
let persistOnExit = false;

/**
 * Both span indexes: the frequency of a term is corpus-wide, whichever table a
 * query then ranks. `spans.search` reads these too, but ranks every match first.
 */
const SPAN_INDEXES = [
  { span: 'search_span', fts: 'search_fts' },
  { span: 'workspace_span', fts: 'workspace_fts' },
] as const;

type SpanIndex = (typeof SPAN_INDEXES)[number];

/** Drop the counts for one database, here and on disk; a pass that indexed spans has made them stale. */
export function clearDocumentFrequency(dbName: string): void {
  cache.delete(dbName);
  removeStoredCounts(dbName);
}

/** Write every database's new counts to its store, so the next process skips their lookups. */
export function persistDocumentFrequency(): void {
  clearTimeout(persistTimer);
  persistTimer = undefined;
  for (const [dbName, counts] of cache) {
    if (!counts.dirty || counts.stamp === undefined) continue;
    writeStoredCounts(dbName, counts.stamp, counts.terms);
    counts.dirty = false;
  }
}

function schedulePersist(): void {
  if (!persistOnExit) {
    persistOnExit = true;
    process.once('exit', persistDocumentFrequency);
  }
  persistTimer ??= setTimeout(persistDocumentFrequency, PERSIST_DELAY_MS).unref();
}

/**
 * Highest span id per index. Ids are never reused, so this counts purged spans
 * too, the same way the vocabulary's doc counts do; `count(*)` would read the
 * whole table (0.36 s).
 */
function highestSpanIds(graph: WorkspaceGraph): { search: number; workspace: number } {
  const row = graph.db
    .prepare<[], { search: number | null; workspace: number | null }>(
      `SELECT (SELECT max(span_id) FROM search_span) AS search,
              (SELECT max(span_id) FROM workspace_span) AS workspace`,
    )
    .get();
  return { search: row?.search ?? 0, workspace: row?.workspace ?? 0 };
}

function stampOf(graph: WorkspaceGraph, spanIds: { search: number; workspace: number }): string | undefined {
  try {
    return indexStamp(graph, spanIds);
  } catch {
    return undefined;
  }
}

function loadCounts(graph: WorkspaceGraph): DatabaseCounts {
  const spanIds = highestSpanIds(graph);
  const stamp = stampOf(graph, spanIds);
  const stored = stamp === undefined ? new Map<string, number>() : readStoredCounts(graph.db.name, stamp);
  return {
    terms: stored.size > CACHE_TERMS ? new Map() : stored,
    spans: spanIds.search + spanIds.workspace,
    stamp,
    dirty: false,
  };
}

function countsFor(graph: WorkspaceGraph): DatabaseCounts {
  const key = graph.db.name;
  const known = cache.get(key);
  if (known) return known;
  const fresh = loadCounts(graph);
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
    const counts = countsFor(graph);
    const known = counts.terms.get(term);
    if (known !== undefined) return known;
    if (counts.terms.size >= CACHE_TERMS) counts.terms.clear();
    const count = countSpans(graph, term);
    counts.terms.set(term, count);
    counts.dirty = true;
    if (counts.stamp !== undefined) schedulePersist();
    return count;
  };
}

interface TermStatistics {
  df: DocumentFrequency;
  /** The most spans a term may match in a query over these classes. */
  maxDfFor: (classes: readonly string[]) => number;
}

/**
 * The cap pays for ranking the shared table, whose bm25 runs over every match
 * before a class filter. A cut-over workspace class ranks only its own small
 * table, so it keeps its common terms, which measured +0.018 R@10 (TP-4680).
 */
function ranksSharedTable(graph: WorkspaceGraph, classes: readonly string[]): boolean {
  return classes.includes('transcripts') || hasLegacyWorkspaceSpans(graph);
}

export function graphTermStatistics(graph: WorkspaceGraph): TermStatistics {
  return {
    df: graphDocumentFrequency(graph),
    maxDfFor: (classes) =>
      ranksSharedTable(graph, classes)
        ? documentFrequencyCap(countsFor(graph).spans)
        : Number.POSITIVE_INFINITY,
  };
}
