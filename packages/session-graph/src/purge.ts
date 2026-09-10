import { sessionRef } from "@titan-design/session-read";
import type { SessionGraph } from "./graph.js";
import { KIT } from "./schema.js";

/** Derived tables keyed by `session_id`, reachable from a transcript through `session`. */
const SESSION_SCOPED = ["turn", "permission_phase", "human_edit", "file_checkpoint", "subagent", "session_model_usage"] as const;

/**
 * Drop every derived row one transcript produced, so re-reading it from byte 0
 * rebuilds those rows instead of doubling them.
 *
 * `resetIndex` already states the reason at corpus scale: rewinding alone is not
 * enough, because the accumulating upserts add a second copy of every count. A
 * rewritten single transcript has the same problem one file at a time.
 * `session.turn_count`, the `session_model_usage` token buckets and the
 * commit/push counts all sum into what is already there, and rows the rewrite
 * removed are never deleted — `fact` survives on its unique
 * `(transcript_id, byte_offset)` index, so stale facts simply persist.
 *
 * Shared identity rows survive on purpose. `pr`, `branch`, `file`, `task` and
 * `artifact` are keyed by ref, many transcripts assert the same one, and the
 * inserts are insert-if-absent; a single transcript cannot know whether it was
 * the only source. The two observation tables are left for the same reason —
 * `reconcile` folds them, and re-reading re-asserts the same rows.
 */
export function purgeTranscript(graph: SessionGraph, transcriptId: number): void {
  graph.db.transaction(() => {
    const owned = graph.db.prepare("SELECT session_id FROM session WHERE transcript_id = ?").all(transcriptId) as { session_id: string }[];
    for (const { session_id } of owned) graph.spans.purgeOwner(sessionRef(session_id));

    // Children first: each subquery reads the `session` rows deleted last.
    for (const table of SESSION_SCOPED) {
      graph.db.prepare(`DELETE FROM "${table}" WHERE session_id IN (SELECT session_id FROM session WHERE transcript_id = ?)`).run(transcriptId);
    }
    graph.db.prepare(`DELETE FROM "${KIT.edge}" WHERE fact_id IN (SELECT fact_id FROM fact WHERE transcript_id = ?)`).run(transcriptId);
    graph.db.prepare("DELETE FROM fact WHERE transcript_id = ?").run(transcriptId);
    graph.db.prepare("DELETE FROM session WHERE transcript_id = ?").run(transcriptId);
  })();
}
