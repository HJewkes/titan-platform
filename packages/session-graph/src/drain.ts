import { Clusterer, hasErrorSignal, parseClustererSnapshot } from "@titan-design/cluster";
import { nowIso, type Migration } from "@titan-design/store-sqlite";
import type { SessionGraph } from "./graph.js";
import { normalizedErrorFacts, readIndexedText, type NormalizedErrorFact } from "./normalized-query.js";

/** Error blobs are partitioned as one tool type until tool names are threaded through facts. */
const PARTITION = "tool_result";

/**
 * Drain's tables live in the 2000 band, above session-graph's own migrations and below
 * nothing else of this package's: a product layering them on its graph composes them with
 * its own versions. Templates and occurrences hold ids and locators only, never blob text.
 */
export const DRAIN_TEMPLATE_MIGRATION: Migration = {
  version: 2000,
  name: "drain templates",
  up: (db) =>
    db.exec(`
      CREATE TABLE IF NOT EXISTS template (
        template_id      TEXT PRIMARY KEY,
        partition        TEXT NOT NULL,
        masked_signature TEXT NOT NULL,
        created_at       TEXT NOT NULL,
        occurrence_count INTEGER NOT NULL DEFAULT 0,
        exemplar_transcript_id INTEGER NOT NULL,
        exemplar_byte_offset   INTEGER NOT NULL,
        exemplar_byte_length   INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS occurrence (
        template_id   TEXT NOT NULL,
        transcript_id INTEGER NOT NULL,
        byte_offset   INTEGER NOT NULL,
        byte_length   INTEGER NOT NULL,
        session_id    TEXT NOT NULL,
        ts            TEXT NOT NULL,
        params        TEXT,
        PRIMARY KEY (transcript_id, byte_offset)
      );
      CREATE INDEX IF NOT EXISTS idx_occurrence_template ON occurrence(template_id);
      CREATE TABLE IF NOT EXISTS clusterer_snapshot (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        snapshot TEXT NOT NULL,
        saved_at TEXT NOT NULL
      );
    `),
};

export const DRAIN_SCREENED_MIGRATION: Migration = {
  version: 2002,
  name: "screened tool results",
  up: (db) =>
    db.exec(`
      CREATE TABLE IF NOT EXISTS drain_screened (
        transcript_id INTEGER NOT NULL, byte_offset INTEGER NOT NULL,
        source_hash TEXT NOT NULL, PRIMARY KEY(transcript_id,byte_offset,source_hash)
      )`),
};

export interface DrainSummary {
  candidates: number;
  screened: number;
  clustered: number;
  newTemplates: number;
  templates: number;
  unreadable: number;
}

export interface TemplateRow {
  templateId: string;
  maskedSignature: string;
  occurrenceCount: number;
  createdAt: string;
}

interface ErrorFact {
  transcriptId: number;
  byteOffset: number;
  byteLength: number;
  sessionId: string;
  ts: string;
  sourceHash: string;
}

interface ClaudeFactRow {
  transcript_id: number;
  byte_offset: number;
  byte_length: number;
  session_id: string;
  ts: string;
  source_hash: string;
}

/** Cluster tool-result error facts not yet handled into recurring failure templates. */
export async function ingestDrain(graph: SessionGraph, options: { limit?: number } = {}): Promise<DrainSummary> {
  const clusterer = loadClusterer(graph);
  const summary: DrainSummary = { candidates: 0, screened: 0, clustered: 0, newTemplates: 0, templates: 0, unreadable: 0 };
  for (const fact of pendingErrorFacts(graph, options.limit)) {
    summary.candidates += 1;
    const text = await readIndexedText(graph, { sourceId: fact.transcriptId, byteOffset: fact.byteOffset, byteLength: fact.byteLength, field: "tool_result" });
    if (text === null) {
      summary.unreadable += 1;
      continue;
    }
    if (!hasErrorSignal(PARTITION, text)) {
      summary.screened += 1;
      graph.db.prepare("INSERT OR IGNORE INTO drain_screened VALUES (?,?,?)").run(fact.transcriptId, fact.byteOffset, fact.sourceHash);
      continue;
    }
    const result = clusterer.cluster({ partition: PARTITION, text });
    recordOccurrence(graph, fact, result.templateId, result.maskedSignature, result.extractedParams);
    summary.clustered += 1;
    if (result.isNewTemplate) summary.newTemplates += 1;
  }
  saveClusterer(graph, clusterer);
  summary.templates = graph.db.prepare<[], { n: number }>("SELECT count(*) AS n FROM template").get()?.n ?? 0;
  return summary;
}

/** Recurring failure templates, most frequent first. */
export function listTemplates(graph: SessionGraph, limit: number): TemplateRow[] {
  const rows = graph.db
    .prepare<[number], { template_id: string; masked_signature: string; occurrence_count: number; created_at: string }>(
      "SELECT template_id, masked_signature, occurrence_count, created_at FROM template ORDER BY occurrence_count DESC, created_at LIMIT ?",
    )
    .all(limit);
  return rows.map((r) => ({ templateId: r.template_id, maskedSignature: r.masked_signature, occurrenceCount: r.occurrence_count, createdAt: r.created_at }));
}

/** Error facts not yet clustered, from Claude transcripts and normalized sources, oldest first. */
function pendingErrorFacts(graph: SessionGraph, limit?: number): ErrorFact[] {
  const claude = graph.db.prepare<[number], ClaudeFactRow>(`${CLAUDE_ERROR_FACTS} ORDER BY f.ts LIMIT ?`).all(limit ?? -1).map(fromClaudeRow);
  const handled = graph.db.prepare(`SELECT 1 FROM occurrence WHERE transcript_id = ? AND byte_offset = ?
    UNION ALL SELECT 1 FROM drain_screened WHERE transcript_id = ? AND byte_offset = ? AND source_hash = ?`);
  const normalized = normalizedErrorFacts(graph)
    .filter((f) => !handled.get(f.transcriptId, f.byteOffset, f.transcriptId, f.byteOffset, f.sourceHash))
    .slice(0, limit)
    .map(fromNormalized);
  return [...claude, ...normalized].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0)).slice(0, limit);
}

const CLAUDE_ERROR_FACTS = `SELECT f.transcript_id, f.byte_offset, f.byte_length, f.session_id, f.ts, COALESCE(t.content_hash,t.prefix_hash,'') AS source_hash
       FROM fact f JOIN transcript t ON t.source_id = f.transcript_id
       LEFT JOIN occurrence o ON o.transcript_id = f.transcript_id AND o.byte_offset = f.byte_offset
       LEFT JOIN drain_screened d ON d.transcript_id = f.transcript_id AND d.byte_offset = f.byte_offset AND d.source_hash = COALESCE(t.content_hash,t.prefix_hash,'')
       WHERE f.event_type = 'tool_result_error' AND o.template_id IS NULL AND d.transcript_id IS NULL AND t.status = 'ok'`;

function fromClaudeRow(r: ClaudeFactRow): ErrorFact {
  return { transcriptId: r.transcript_id, byteOffset: r.byte_offset, byteLength: r.byte_length, sessionId: r.session_id, ts: r.ts, sourceHash: r.source_hash };
}

function fromNormalized(f: NormalizedErrorFact): ErrorFact {
  return { transcriptId: f.transcriptId, byteOffset: f.byteOffset, byteLength: f.byteLength, sessionId: f.conversationRef, ts: f.ts, sourceHash: f.sourceHash };
}

function recordOccurrence(graph: SessionGraph, fact: ErrorFact, templateId: string, maskedSignature: string, params: Record<string, string>): void {
  graph.db
    .prepare(
      `INSERT INTO template (template_id, partition, masked_signature, created_at, occurrence_count, exemplar_transcript_id, exemplar_byte_offset, exemplar_byte_length)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?)
       ON CONFLICT (template_id) DO UPDATE SET occurrence_count = occurrence_count + 1`,
    )
    .run(templateId, PARTITION, maskedSignature, fact.ts, fact.transcriptId, fact.byteOffset, fact.byteLength);
  graph.db
    .prepare("INSERT INTO occurrence (template_id, transcript_id, byte_offset, byte_length, session_id, ts, params) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING")
    .run(templateId, fact.transcriptId, fact.byteOffset, fact.byteLength, fact.sessionId, fact.ts, Object.keys(params).length ? JSON.stringify(params) : null);
}

function loadClusterer(graph: SessionGraph): Clusterer {
  const row = graph.db.prepare<[], { snapshot: string }>("SELECT snapshot FROM clusterer_snapshot WHERE id = 1").get();
  return row ? Clusterer.fromSnapshot(parseClustererSnapshot(JSON.parse(row.snapshot))) : new Clusterer();
}

function saveClusterer(graph: SessionGraph, clusterer: Clusterer): void {
  graph.db
    .prepare("INSERT INTO clusterer_snapshot (id, snapshot, saved_at) VALUES (1, ?, ?) ON CONFLICT (id) DO UPDATE SET snapshot = excluded.snapshot, saved_at = excluded.saved_at")
    .run(JSON.stringify(clusterer.snapshot()), nowIso());
}
