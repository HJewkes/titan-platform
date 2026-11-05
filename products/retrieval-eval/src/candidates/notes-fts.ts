import { SpanFtsTables, hasTable, openDatabase, type Db } from "@titan-design/store-sqlite";
import type { ScoredHit } from "../metrics.js";
import { terms } from "../query/variants.js";
import { noteAliases, type Candidate } from "./candidate.js";

/**
 * The notes-only span search the bootstrap already runs, reproduced.
 *
 * Mirrors `active-work src/bootstrap/rank-notes.ts`: the same `note:` owner
 * prefix, the same OR-of-quoted-terms expression, the same depth of 300. What
 * it deliberately drops is the recency fusion and the foreign floor — those
 * are presentation rules about which notes to *show*, and folding them in here
 * would measure the bootstrap's display policy rather than its retrieval.
 */

/** Well past any cap, matching the bootstrap; the dedupe by owner does the cutting. */
const SEARCH_DEPTH = 300;

export function matchExpression(query: string): string {
  return [...new Set(terms(query))].map((term) => `"${term}"`).join(" OR ");
}

export interface NotesFtsOptions {
  graphPath: string;
  activeRoot: string;
}

/** Read-only, always: the live graph is the daemon's and this harness is a guest in it. */
export function openReadOnly(graphPath: string): Db {
  return openDatabase(graphPath, { readonly: true });
}

/**
 * Workspace spans sit at or above this `source_id` in `search_span` before the
 * TP-4680 cutover. Mirrors active-work's constant; no product depends on
 * another's source, so the value is repeated and this test pins the behaviour.
 */
const WORKSPACE_SOURCE_BASE = 1_000_000_000;

function hasRows(db: Db, sql: string, ...params: unknown[]): boolean {
  return db.prepare(sql).get(...params) !== undefined;
}

/**
 * Where the notes live right now.
 *
 * After the cutover they are in `workspace_span` and `search_span` holds only
 * transcripts, so reading `search` alone returns nothing, silently. While legacy
 * workspace spans remain in `search_span` the backfill is unfinished and the new
 * table is partial, so the shared table is still the complete one.
 */
function noteSpans(db: Db): SpanFtsTables {
  const flipped =
    hasTable(db, "workspace_span") &&
    hasTable(db, "workspace_fts") &&
    hasRows(db, "SELECT 1 FROM workspace_span LIMIT 1") &&
    !hasRows(db, "SELECT 1 FROM search_span WHERE source_id >= ? LIMIT 1", WORKSPACE_SOURCE_BASE);
  return new SpanFtsTables(db, flipped ? { name: "workspace", contentlessDelete: true } : { name: "search" });
}

export function notesFts(options: NotesFtsOptions): Candidate {
  const db = openReadOnly(options.graphPath);
  return {
    name: "notes-fts",
    async search(query, limit) {
      const expression = matchExpression(query);
      if (expression.length === 0) return [];
      return rankOwners(noteSpans(db), expression, limit, options.activeRoot);
    },
    close() {
      db.close();
    },
  };
}

/**
 * Collapse spans to owners, best span first.
 *
 * A long note holds many spans and would otherwise fill the whole result set
 * with itself. The first span an owner appears at is its best, since the query
 * returns rows in rank order.
 */
function rankOwners(spans: SpanFtsTables, expression: string, limit: number, activeRoot: string): ScoredHit[] {
  const seen = new Set<string>();
  const hits: ScoredHit[] = [];
  for (const span of spans.search(expression, SEARCH_DEPTH, { ownerPrefix: "note:" })) {
    if (seen.has(span.ownerRef)) continue;
    seen.add(span.ownerRef);
    hits.push({ id: span.ownerRef, aliases: noteAliases(span.ownerRef, activeRoot), chars: span.byteLength });
    if (hits.length >= limit) break;
  }
  return hits;
}
