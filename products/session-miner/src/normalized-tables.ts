import type { SessionGraph } from "@titan-design/session-graph";
import { hasTable } from "@titan-design/store-sqlite";

/** A graph opened read-only may have lost its `normalized_*` tables to migration 9; reads then see nothing. */
export function hasNormalized(graph: SessionGraph): boolean {
  return hasTable(graph.db, "normalized_event") && hasTable(graph.db, "normalized_source");
}

export function countNormalizedSessions(graph: SessionGraph): number {
  if (!hasNormalized(graph)) return 0;
  return (graph.db.prepare("SELECT count(DISTINCT conversation_ref) AS n FROM normalized_source").get() as { n: number }).n;
}
