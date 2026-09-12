import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { contentHash } from "@titan-design/locator";
import { conversationRef } from "@titan-design/agent-protocol";
import { SPAN_TEXT_CAP, readCodexObservations, type CodexReadResult, type NormalizedSessionObservation, type SessionSourceDescriptor, type SourceTextLocator } from "@titan-design/session-read";
import type { SessionGraph } from "./graph.js";
import { insertObservation, observationText } from "./normalized-project.js";

export interface NormalizedIndexResult { status: "indexed" | "unchanged" | "missing" | "quarantined"; conversationRef: string; observations: number; reason?: string }

/** Replay changed sources into temporary staging; swap rows and watermark atomically. */
export async function indexCodexSource(graph: SessionGraph, source: SessionSourceDescriptor): Promise<NormalizedIndexResult> {
  const ref = conversationRef(source.conversation);
  const base = { conversationRef: ref, observations: 0 };
  const row = graph.transcripts.ensure(source.sourceId);
  let info;
  try { info = await stat(source.path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    graph.transcripts.markStatus(source.sourceId, "missing", "source unavailable");
    return { ...base, status: "missing" };
  }
  // Always replay: the decoder verifies bytes, detects projections that arrived later,
  // and avoids trusting mtime alone. Equality of the resulting prefix is the fast no-op.
  const stage = `stage_${randomUUID().replaceAll("-", "")}`;
  graph.db.exec(`CREATE TEMP TABLE ${stage}(seq INTEGER PRIMARY KEY, observation TEXT NOT NULL)`);
  let result: CodexReadResult | undefined;
  try {
    const fingerprint = await contentHash(source.path);
    const insert = graph.db.prepare(`INSERT INTO ${stage}(observation) VALUES (?)`);
    for await (const observation of readCodexObservations(source, {}, done => { result = done; })) insert.run(JSON.stringify(observation));
    if (!result) throw new Error("decoder completed without a resume boundary");
    const boundary = (result as CodexReadResult).resumeBoundary;
    const prior = graph.db.prepare("SELECT descriptor FROM normalized_source WHERE transcript_id = ?").get(row.sourceId) as { descriptor: string } | undefined;
    if (prior && row.contentHash === fingerprint && row.prefixHash === boundary.prefixHash && row.lastOffset === boundary.byteOffset) {
      graph.db.prepare("UPDATE normalized_source SET descriptor = ? WHERE transcript_id = ?").run(JSON.stringify(source), row.sourceId);
      graph.transcripts.markStatus(source.sourceId, "ok", null);
      return { ...base, status: "unchanged" };
    }
    const count = graph.db.transaction(() => {
      purgeNormalizedSource(graph, row.sourceId);
      graph.db.prepare("INSERT OR IGNORE INTO conversation(ref,harness,namespace,native_id) VALUES (?,?,?,?)").run(ref, source.harness, source.namespace, source.conversation.nativeId);
      graph.db.prepare("INSERT OR REPLACE INTO normalized_source VALUES (?,?,?,?)").run(row.sourceId, source.sourceId, ref, JSON.stringify(source));
      const n = applyStaged(graph, stage, row.sourceId, ref);
      graph.transcripts.advance(source.sourceId, { lastOffset: boundary.byteOffset, prefixHash: boundary.prefixHash, fileSize: info.size, fileMtime: info.mtime.toISOString(), contentHash: fingerprint });
      return n;
    })();
    return { ...base, status: "indexed", observations: count };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    graph.transcripts.markStatus(source.sourceId, "quarantined", reason);
    return { ...base, status: "quarantined", reason };
  } finally { graph.db.exec(`DROP TABLE ${stage}`); }
}

function applyStaged(graph: SessionGraph, stage: string, transcriptId: number, ref: string): number {
  const spans = `${stage}_spans`;
  graph.db.exec(`CREATE TEMP TABLE ${spans}(field TEXT, offset INTEGER, length INTEGER, text TEXT, locators TEXT, PRIMARY KEY(field,offset))`);
  let count = 0;
  try {
    for (const row of stagedRows<{ observation: string }>(graph, stage)) {
      const o = JSON.parse(row.observation) as NormalizedSessionObservation;
      insertObservation(graph, transcriptId, o);
      for (const p of observationText(o)) stageText(graph, spans, p.field, p.text, p.locator);
      count++;
    }
    for (const s of stagedRows<{ field: string; offset: number; length: number; text: string; locators: string }>(graph, spans)) {
      const id = graph.spans.index({ ownerRef: ref, sourceId: transcriptId, field: s.field, byteOffset: s.offset, byteLength: s.length }, s.text);
      graph.db.prepare("INSERT INTO normalized_span VALUES (?,?)").run(id, s.locators);
    }
  } finally { graph.db.exec(`DROP TABLE ${spans}`); }
  return count;
}

function stageText(graph: SessionGraph, table: string, field: string, text: string, locator: SourceTextLocator): void {
  const line = locator.evidence.line;
  const prior = graph.db.prepare(`SELECT text,locators FROM ${table} WHERE field = ? AND offset = ?`).get(field, line.byteOffset) as { text: string; locators: string } | undefined;
  const locators = prior ? JSON.parse(prior.locators) as unknown[] : [];
  locators.push(locator);
  graph.db.prepare(`INSERT OR REPLACE INTO ${table} VALUES (?,?,?,?,?)`).run(field, line.byteOffset, line.byteLength, (prior ? `${prior.text}\n${text}` : text).slice(0, SPAN_TEXT_CAP), JSON.stringify(locators));
}

function purgeNormalizedSource(graph: SessionGraph, transcriptId: number): void {
  graph.db.prepare("DELETE FROM normalized_span WHERE span_id IN (SELECT span_id FROM search_span WHERE source_id = ?)").run(transcriptId);
  graph.db.prepare("DELETE FROM search_span WHERE source_id = ?").run(transcriptId);
  graph.db.prepare("DELETE FROM normalized_event WHERE transcript_id = ?").run(transcriptId);
}


/** Finish each SELECT before writing; SQLite forbids writes during an active iterator. */
function* stagedRows<T>(graph: SessionGraph, table: string): Generator<T> {
  const select = graph.db.prepare(`SELECT rowid AS cursor, * FROM ${table} WHERE rowid > ? ORDER BY rowid LIMIT 128`);
  let cursor = 0;
  for (;;) {
    const rows = select.all(cursor) as (T & { cursor: number })[];
    if (!rows.length) return;
    for (const row of rows) { cursor = row.cursor; yield row; }
  }
}
