import { EXTRACT_VERSION, TranscriptParseError, extractTranscript, type DiscoveredTranscript, type TranscriptDelta } from "@titan-design/session-read";
import type { Db, WatermarkRow } from "@titan-design/store-sqlite";
import { applyAudit } from "./audit-apply.js";
import { AUDIT_TABLES, FACET_TABLE } from "./audit-schema.js";
import type { SessionGraph } from "./graph.js";

/** The one facet today: the eight audit tables, all written from the same extraction. */
export const AUDIT_FACET = "audit";

/** Transcripts re-extracted per pass, so a daemon's pass stays short while the backlog drains. */
export const DEFAULT_FACET_LIMIT = 40;

export interface BackfillOptions {
  /** Transcripts visited this pass. `Infinity` clears the whole backlog. */
  limit?: number;
  /** The extraction version a facet must reach. Defaults to session-read's `EXTRACT_VERSION`. */
  version?: number;
}

export interface BackfillSummary {
  backfilled: number;
  /** Stale transcripts left for later passes. */
  backlog: number;
  /** Sessions whose audit rows were rebuilt, for the caller's rollup. */
  sessionIds: string[];
}

interface Candidate {
  row: WatermarkRow;
  transcript: DiscoveredTranscript;
}

/**
 * Bring the audit facet of already-indexed transcripts up to `version` without a
 * full rebuild: re-read each one up to its watermark and replace only its audit
 * rows. Legacy tables are never written, so their accumulating counts cannot double.
 */
export async function backfillFacets(graph: SessionGraph, transcripts: readonly DiscoveredTranscript[], options: BackfillOptions = {}): Promise<BackfillSummary> {
  const version = options.version ?? EXTRACT_VERSION;
  const stale = staleTranscripts(graph, transcripts, version);
  const visit = stale.slice(0, options.limit ?? DEFAULT_FACET_LIMIT);
  const sessionIds = new Set<string>();
  let backfilled = 0;
  for (const candidate of visit) {
    const touched = await backfillOne(graph, candidate, version);
    if (!touched) continue;
    backfilled += 1;
    for (const id of touched) sessionIds.add(id);
  }
  return { backfilled, backlog: stale.length - visit.length, sessionIds: [...sessionIds] };
}

/** Discovered, status `ok`, and below `version`; newest first so recent cost history lands first. */
function staleTranscripts(graph: SessionGraph, transcripts: readonly DiscoveredTranscript[], version: number): Candidate[] {
  const byPath = new Map(transcripts.map((t) => [t.displayPath, t]));
  const versions = facetVersions(graph.db);
  const stale: Candidate[] = [];
  for (const row of graph.transcripts.list()) {
    const transcript = byPath.get(row.sourceKey);
    if (!transcript || row.status !== "ok" || (versions.get(row.sourceId) ?? -1) >= version) continue;
    stale.push({ row, transcript });
  }
  return stale.sort((a, b) => (b.row.fileMtime ?? "").localeCompare(a.row.fileMtime ?? ""));
}

function facetVersions(db: Db): Map<number, number> {
  const rows = db.prepare(`SELECT transcript_id, version FROM ${FACET_TABLE} WHERE facet = ?`).all(AUDIT_FACET) as { transcript_id: number; version: number }[];
  return new Map(rows.map((r) => [r.transcript_id, r.version]));
}

/** Returns the sessions touched, or `null` when the file could not be re-read and was marked instead. */
async function backfillOne(graph: SessionGraph, { row, transcript }: Candidate, version: number): Promise<string[] | null> {
  let delta: TranscriptDelta & { lastByteOffset: number };
  try {
    delta = await extractTranscript(transcript.absolutePath, { untilByteOffset: row.lastOffset, subagentId: transcript.subagentId });
  } catch (err) {
    // Mark rather than skip, or a broken file would hold a slot at the head of every pass.
    const status = unreadableStatus(err);
    if (!status) throw err;
    graph.transcripts.markStatus(row.sourceKey, status, err instanceof Error ? err.message : String(err));
    return null;
  }
  graph.db.transaction(() => {
    for (const table of AUDIT_TABLES) graph.db.prepare(`DELETE FROM "${table}" WHERE transcript_id = ?`).run(row.sourceId);
    applyAudit(graph.db, row.sourceId, delta);
    writeFacet(graph.db, row.sourceId, version, delta.lastByteOffset);
  })();
  return delta.sessions.map((s) => s.sessionId);
}

function unreadableStatus(err: unknown): "missing" | "quarantined" | null {
  if (err instanceof TranscriptParseError) return "quarantined";
  if ((err as NodeJS.ErrnoException | null)?.code === "ENOENT") return "missing";
  return null;
}

function writeFacet(db: Db, transcriptId: number, version: number, indexedTo: number): void {
  db.prepare(`
    INSERT INTO ${FACET_TABLE} (transcript_id, facet, version, indexed_to) VALUES (?, ?, ?, ?)
    ON CONFLICT (transcript_id, facet) DO UPDATE SET version = excluded.version, indexed_to = excluded.indexed_to`)
    .run(transcriptId, AUDIT_FACET, version, indexedTo);
}

/**
 * Record a forward read. A read from byte 0 covers the whole file, so it sets the
 * facet outright; a resumed read only extends a facet that is already current,
 * because the bytes before it may predate the audit tables.
 */
export function advanceFacet(db: Db, transcriptId: number, fromByteOffset: number, indexedTo: number, version: number = EXTRACT_VERSION): void {
  if (fromByteOffset === 0) {
    writeFacet(db, transcriptId, version, indexedTo);
    return;
  }
  db.prepare(`UPDATE ${FACET_TABLE} SET indexed_to = ? WHERE transcript_id = ? AND facet = ? AND version = ?`)
    .run(indexedTo, transcriptId, AUDIT_FACET, version);
}
