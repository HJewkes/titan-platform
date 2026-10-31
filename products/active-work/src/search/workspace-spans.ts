import type { SpanFtsTables } from '@titan-design/store-sqlite';
import type { WorkspaceGraph } from '../session-index/graph.js';
import { WORKSPACE_SPAN_SOURCE_BASE } from '../workspace-index/schema.js';

/**
 * Which span table a workspace-class query reads (TP-4680).
 *
 * Workspace spans move from the shared `search_span` into `workspace_span`, and
 * the move is derived from the data rather than a flag: while any span at or
 * above the workspace base remains in `search_span`, the graph is not cut over
 * and readers stay there, so workspace search never goes dark mid-backfill.
 * The flip deletes those rows in one transaction, and readers change over on
 * its commit.
 *
 * `cutover` is off by default because nothing writes the new table yet. With it
 * off this always answers `graph.spans`, which is exactly the table every
 * reader used before. The transcripts class never asks: it reads `graph.spans`.
 */
export interface WorkspaceSpanOptions {
  cutover?: boolean;
}

/** An `idx_search_span_source` range probe: one index seek, not a scan. */
export function hasLegacyWorkspaceSpans(graph: WorkspaceGraph): boolean {
  const row = graph.db
    .prepare<[number], { hit: number }>(
      'SELECT 1 AS hit FROM search_span WHERE source_id >= ? LIMIT 1',
    )
    .get(WORKSPACE_SPAN_SOURCE_BASE);
  return row !== undefined;
}

export function workspaceSpanTable(
  graph: WorkspaceGraph,
  options: WorkspaceSpanOptions = {},
): SpanFtsTables {
  if (!options.cutover) return graph.spans;
  return hasLegacyWorkspaceSpans(graph) ? graph.spans : graph.workspaceSpans;
}
