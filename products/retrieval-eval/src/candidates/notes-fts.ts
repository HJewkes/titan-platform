import { SpanFtsTables, openDatabase, type Db } from "@titan-design/store-sqlite";
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

export function notesFts(options: NotesFtsOptions): Candidate {
  const db = openReadOnly(options.graphPath);
  const spans = new SpanFtsTables(db, { name: "search" });
  return {
    name: "notes-fts",
    async search(query, limit) {
      const expression = matchExpression(query);
      if (expression.length === 0) return [];
      return rankOwners(spans, expression, limit, options.activeRoot);
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
