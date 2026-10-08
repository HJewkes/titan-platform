import { contentHash, prefixHash } from "@titan-design/locator";
import type { UsageMeasurement } from "@titan-design/agent-protocol";
import { expandHome, readSessionSourceText, readSessionText, SessionUsageAccumulator, type SessionUsageSummary, type SourceTextLocator, type SessionSourceDescriptor, type SpanField } from "@titan-design/session-read";
import { hasTable } from "@titan-design/store-sqlite";
import os from "node:os";
import type { SessionGraph } from "./graph.js";
import { stripInjected } from "./injected-text.js";

export interface IndexedSpan { sourceId: number; byteOffset: number; byteLength: number; field: string; spanId?: number }
/** One resolver for search and error clustering; never display a raw JSON line. */
export async function readIndexedText(graph: SessionGraph, span: IndexedSpan, options: { homeDir?: string } = {}): Promise<string | null> {
  const text = await readSourceText(graph, span, options.homeDir ?? os.homedir());
  return text !== null && span.field === "prompt" ? stripInjected(text) : text;
}

async function readSourceText(graph: SessionGraph, span: IndexedSpan, homeDir: string): Promise<string | null> {
  const row = !hasTable(graph.db, "normalized_span") ? undefined : graph.db.prepare(`SELECT n.locators FROM normalized_span n JOIN search_span s USING(span_id)
    WHERE s.source_id = ? AND s.byte_offset = ? AND s.field = ?`).get(span.sourceId, span.byteOffset, span.field) as { locators: string } | undefined;
  if (row) {
    const source = graph.db.prepare("SELECT descriptor FROM normalized_source WHERE transcript_id = ?").get(span.sourceId) as { descriptor: string } | undefined;
    if (!source) return null;
    const descriptor = JSON.parse(source.descriptor) as SessionSourceDescriptor;
    const watermark = graph.transcripts.list().find(t => t.sourceId === span.sourceId);
    try { if (!watermark?.prefixHash || await prefixHash(descriptor.path, watermark.lastOffset) !== watermark.prefixHash) return null; }
    catch { return null; }
    if (span.byteOffset + span.byteLength + 1 > watermark.lastOffset) {
      try { if (!watermark.contentHash || await contentHash(descriptor.path) !== watermark.contentHash) return null; } catch { return null; }
    }
    const texts = await Promise.all((JSON.parse(row.locators) as SourceTextLocator[]).map(locator => readSessionSourceText(locator, { sources: [JSON.parse(source.descriptor) as SessionSourceDescriptor] })));
    return texts.some(text => text === null) ? null : texts.join("\n");
  }
  const normalized = hasTable(graph.db, "normalized_source") && graph.db.prepare("SELECT 1 FROM normalized_source WHERE transcript_id = ?").get(span.sourceId);
  if (normalized) return null;
  const legacy = graph.transcripts.list().find(t => t.sourceId === span.sourceId);
  return legacy ? readSessionText({ path: expandHome(legacy.sourceKey, homeDir), byteOffset: span.byteOffset, byteLength: span.byteLength, field: span.field as SpanField }) : null;
}

/** A graph opened read-only may have lost its `normalized_*` tables to migration 9; every normalized reader then sees nothing. */
export function hasNormalizedTables(graph: SessionGraph): boolean {
  return hasTable(graph.db, "normalized_event") && hasTable(graph.db, "normalized_source");
}

export function countNormalizedSessions(graph: SessionGraph): number {
  if (!hasNormalizedTables(graph)) return 0;
  return (graph.db.prepare("SELECT count(DISTINCT conversation_ref) AS n FROM normalized_source").get() as { n: number }).n;
}

export function countNormalizedEvents(graph: SessionGraph): number {
  if (!hasNormalizedTables(graph)) return 0;
  return (graph.db.prepare("SELECT count(*) AS n FROM normalized_event").get() as { n: number }).n;
}

/** The transcript's own file for a normalized source, or null when the transcript is not one. */
export function normalizedSourcePath(graph: SessionGraph, transcriptId: number): string | null {
  if (!hasNormalizedTables(graph)) return null;
  const row = graph.db.prepare("SELECT descriptor FROM normalized_source WHERE transcript_id = ?").get(transcriptId) as { descriptor: string } | undefined;
  return row ? (JSON.parse(row.descriptor) as SessionSourceDescriptor).path : null;
}

export interface ConversationSummary {
  sessionId: string; harness: string; nativeId: string; namespace: string;
  title: string | null; startedAt: string | null; endedAt: string | null;
  cwd: string | null; gitBranch: string | null; turnCount: number; commitCount: number | null; pushCount: number | null;
}
export function normalizedSessions(graph: SessionGraph, options: { ref?: string; limit?: number; since?: string } = {}): ConversationSummary[] {
  if (!hasNormalizedTables(graph)) return [];
  const rows = graph.db.prepare(`SELECT c.ref,c.harness,c.native_id,c.namespace,MIN(e.ts) AS started,
    COUNT(DISTINCT CASE WHEN e.kind = 'native_turn' THEN e.turn_ref END) AS turns
    FROM conversation c JOIN (SELECT DISTINCT conversation_ref FROM normalized_source) s ON s.conversation_ref = c.ref
    LEFT JOIN normalized_event e ON e.conversation_ref = c.ref AND e.history_origin IS NULL
    WHERE c.legacy_session_id IS NULL AND (? IS NULL OR c.ref = ?)
    GROUP BY c.ref HAVING (? IS NULL OR MIN(e.ts) >= ?)
    ORDER BY started DESC LIMIT ?`).all(options.ref ?? null,options.ref ?? null,options.since ?? null,options.since ?? null,options.limit ?? -1) as
    { ref: string; harness: string; native_id: string; namespace: string; started: string | null; turns: number }[];
  const meta = graph.db.prepare(`SELECT json_extract(j.value,'$.value') AS value
    FROM normalized_event e,json_each(e.metadata) j WHERE e.conversation_ref = ?
    AND e.history_origin IS NULL AND json_extract(j.value,'$.name') = ? ORDER BY e.ts DESC,e.byte_offset DESC,e.subrecord_index DESC LIMIT 1`);
  return rows.map(c => {
    const text = (key: string) => { const value = (meta.get(c.ref,key) as { value: unknown } | undefined)?.value; return typeof value === "string" ? value : null; };
    return { sessionId:c.ref,harness:c.harness,nativeId:c.native_id,namespace:c.namespace,title:text("title"),startedAt:c.started,
      endedAt:null,cwd:text("cwd"),gitBranch:text("git_branch"),turnCount:c.turns,commitCount:null,pushCount:null };
  });
}

export type NormalizedUsageSummary = SessionUsageSummary;
/** Shared storage-free usage policy keeps graph and direct readers consistent. */
export function normalizedUsage(graph: SessionGraph, ref: string): NormalizedUsageSummary[] {
  if (!hasNormalizedTables(graph)) return [];
  // Snapshot epochs are local to a physical source; never add copies from different files.
  // Pick the source with the latest native timestamp (then fullest coverage, then stable ID).
  const preferred = graph.db.prepare(`SELECT transcript_id FROM normalized_event
    WHERE conversation_ref = ? AND usage IS NOT NULL AND history_origin IS NULL
    GROUP BY transcript_id ORDER BY MAX(ts) DESC, COUNT(*) DESC, transcript_id ASC LIMIT 1`).get(ref) as { transcript_id: number } | undefined;
  const rows = graph.db.prepare(`SELECT usage FROM normalized_event WHERE conversation_ref = ?
    AND usage IS NOT NULL AND history_origin IS NULL
    AND (json_extract(usage,'$.kind') = 'delta' OR transcript_id = ?)
    ORDER BY byte_offset,subrecord_index`);
  const accumulator = new SessionUsageAccumulator();
  for (const row of rows.iterate(ref, preferred?.transcript_id ?? -1) as Iterable<{ usage: string }>) {
    accumulator.add(JSON.parse(row.usage) as UsageMeasurement);
  }
  return accumulator.summaries();
}

export interface NormalizedTurn { turnRef: string; startedAt: string | null; endedAt: string | null; toolCalls: number }
export interface NormalizedConversationDetail {
  turns: NormalizedTurn[];
  edges: { relation: string; targetRef: string }[];
  inbound: { relation: string; sourceRef: string }[];
}
/** Turns in start order with their distinct tool calls, plus lineage both ways. */
export function normalizedConversationDetail(graph: SessionGraph, ref: string): NormalizedConversationDetail {
  if (!hasNormalizedTables(graph)) return { turns: [], edges: [], inbound: [] };
  const turns = graph.db.prepare(`SELECT t.turn_ref,t.started,t.ended,COALESCE(c.n,0) AS tool_calls
    FROM (SELECT turn_ref,MIN(ts) AS started,MAX(ts) AS ended FROM normalized_event
      WHERE conversation_ref = ? AND history_origin IS NULL AND kind = 'native_turn' GROUP BY turn_ref) t
    LEFT JOIN (SELECT turn_ref,count(DISTINCT call_ref) AS n FROM normalized_event
      WHERE conversation_ref = ? AND history_origin IS NULL AND kind = 'tool_call' GROUP BY turn_ref) c USING(turn_ref)
    ORDER BY t.started,t.turn_ref`).all(ref, ref) as { turn_ref: string; started: string | null; ended: string | null; tool_calls: number }[];
  const edges = graph.db.prepare("SELECT DISTINCT relationship,related_ref FROM normalized_event WHERE conversation_ref = ? AND kind = 'lineage'").all(ref) as { relationship: string; related_ref: string }[];
  const inbound = graph.db.prepare("SELECT DISTINCT relationship,conversation_ref FROM normalized_event WHERE related_ref = ? AND kind = 'lineage'").all(ref) as { relationship: string; conversation_ref: string }[];
  return {
    turns: turns.map(t => ({ turnRef: t.turn_ref, startedAt: t.started, endedAt: t.ended, toolCalls: t.tool_calls })),
    edges: edges.map(e => ({ relation: e.relationship, targetRef: e.related_ref })),
    inbound: inbound.map(e => ({ relation: e.relationship, sourceRef: e.conversation_ref })),
  };
}

export interface NormalizedErrorFact {
  transcriptId: number; byteOffset: number; byteLength: number; conversationRef: string;
  ts: string; path: string; sourceHash: string;
}
/** Error tool results of readable transcripts, one per source line, oldest first. */
export function normalizedErrorFacts(graph: SessionGraph): NormalizedErrorFact[] {
  if (!hasNormalizedTables(graph)) return [];
  return graph.db.prepare(`SELECT n.transcript_id AS transcriptId,n.byte_offset AS byteOffset,MAX(n.byte_length) AS byteLength,
      n.conversation_ref AS conversationRef,COALESCE(MIN(n.ts),t.created_at) AS ts,t.source_key AS path,
      COALESCE(t.content_hash,t.prefix_hash,'') AS sourceHash
    FROM normalized_event n JOIN transcript t ON t.source_id = n.transcript_id
    WHERE n.kind = 'tool_result' AND n.is_error IS NOT 0 AND t.status = 'ok'
    GROUP BY n.transcript_id,n.byte_offset ORDER BY ts`).all() as NormalizedErrorFact[];
}
