import { sessionRef } from "@titan-design/session-read";
import type { SessionGraph } from "./graph.js";
import { AUDIT_TABLES, FACET_TABLE } from "./audit-schema.js";
import { EPISODE_TABLE } from "./origin-schema.js";
import { REVIEW_TABLE } from "./review-schema.js";
import { recountSessions } from "./rollup.js";
import { KIT } from "./schema.js";

/** Derived tables keyed by `session_id`, reachable from a transcript through `session`. */
const SESSION_SCOPED = ["turn", "permission_phase", "human_edit", "file_checkpoint", "subagent", "session_model_usage", EPISODE_TABLE] as const;

/**
 * Rows that point at the fact that asserted them. Their inserts keep the first copy's fact, so a
 * row the other copy also asserted may point here; it moves to that copy's matching line.
 */
const FACT_LINKED = [
  ["turn", "fact_id_start"],
  ["permission_phase", "fact_id"],
  ["human_edit", "fact_id"],
  ["file_checkpoint", "fact_id"],
  ["subagent", "fact_id"],
  [KIT.edge, "fact_id"],
] as const;

/** A verbatim copy of a line in another transcript: the key `RECOUNT_SHARED_SESSIONS` dedupes on. */
const SURVIVING_COPY = `
  SELECT p.fact_id AS purged, MIN(m.fact_id) AS kept FROM fact p
  JOIN fact m ON m.session_id = p.session_id AND m.event_type = p.event_type AND m.ts = p.ts
    AND m.byte_length = p.byte_length AND m.transcript_id <> p.transcript_id
  WHERE p.transcript_id = @transcriptId GROUP BY p.fact_id`;

const SHARED_SESSIONS = `
  SELECT session_id FROM session WHERE transcript_id = @transcriptId
    AND EXISTS (SELECT 1 FROM fact f WHERE f.session_id = session.session_id AND f.transcript_id <> @transcriptId)`;

const HAND_OFF_SHARED_SESSIONS = `
  UPDATE session SET transcript_id = (
    SELECT MIN(f.transcript_id) FROM fact f WHERE f.session_id = session.session_id AND f.transcript_id <> @transcriptId)
  WHERE session_id IN (${SHARED_SESSIONS})`;

function sessionIdOf(row: unknown): string {
  const id = typeof row === "object" && row !== null ? Object.getOwnPropertyDescriptor(row, "session_id")?.value : undefined;
  if (typeof id !== "string") throw new Error("expected a string session_id");
  return id;
}

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
 *
 * Audit rows, facet state and chat review verdicts carry `transcript_id`
 * themselves, so they go by it directly rather than through `session`.
 *
 * A session another transcript also holds (a mirror from another host, a resume
 * that copied its history) is handed to that transcript first, so purging one
 * copy keeps the session. A row pointing at one of this copy's facts moves to the
 * other copy's verbatim line when there is one and goes otherwise, so a line the
 * rewrite removed leaves no phantom and a line the other copy still holds keeps
 * its row. The handed-off sessions are recounted from the facts that remain, and
 * their ids returned so the caller rolls them up even when the re-read no longer
 * holds them. Only this copy's search spans go.
 */
export function purgeTranscript(graph: SessionGraph, transcriptId: number): string[] {
  return graph.db.transaction(() => {
    const handedOff = graph.db.prepare(SHARED_SESSIONS).all({ transcriptId }).map(sessionIdOf);
    graph.db.prepare(HAND_OFF_SHARED_SESSIONS).run({ transcriptId });
    graph.db.prepare(`DELETE FROM "${KIT.spanFts}_span" WHERE source_id = ?`).run(transcriptId);
    const owned = graph.db.prepare("SELECT session_id FROM session WHERE transcript_id = ?").all(transcriptId) as { session_id: string }[];
    for (const { session_id } of owned) graph.spans.purgeOwner(sessionRef(session_id));

    for (const [table, column] of FACT_LINKED) moveToSurvivingCopy(graph, transcriptId, table, column);
    // Children first: each subquery reads the `session` rows deleted last.
    for (const table of SESSION_SCOPED) {
      graph.db.prepare(`DELETE FROM "${table}" WHERE session_id IN (SELECT session_id FROM session WHERE transcript_id = ?)`).run(transcriptId);
    }
    for (const table of [...AUDIT_TABLES, FACET_TABLE, REVIEW_TABLE]) {
      graph.db.prepare(`DELETE FROM "${table}" WHERE transcript_id = ?`).run(transcriptId);
    }
    graph.db.prepare("DELETE FROM fact WHERE transcript_id = ?").run(transcriptId);
    graph.db.prepare("DELETE FROM session WHERE transcript_id = ?").run(transcriptId);
    recountSessions(graph, handedOff);
    return handedOff;
  })();
}

function moveToSurvivingCopy(graph: SessionGraph, transcriptId: number, table: string, column: string): void {
  const thisCopy = `"${column}" IN (SELECT fact_id FROM fact WHERE transcript_id = @transcriptId)`;
  graph.db.prepare(`UPDATE "${table}" SET "${column}" = copy.kept FROM (${SURVIVING_COPY}) AS copy WHERE "${table}"."${column}" = copy.purged`).run({ transcriptId });
  graph.db.prepare(`DELETE FROM "${table}" WHERE ${thisCopy}`).run({ transcriptId });
}
