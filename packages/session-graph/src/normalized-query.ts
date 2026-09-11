import { contentHash, prefixHash } from "@titan-design/locator";
import type { UsageMeasurement } from "@titan-design/agent-protocol";
import { readSessionSourceText, readSessionText, SessionUsageAccumulator, type SessionUsageSummary, type SourceTextLocator, type SessionSourceDescriptor, type SpanField } from "@titan-design/session-read";
import type { SessionGraph } from "./graph.js";

export interface IndexedSpan { sourceId: number; byteOffset: number; byteLength: number; field: string; spanId?: number }
/** One resolver for search and error clustering; never display a raw JSON line. */
export async function readIndexedText(graph: SessionGraph, span: IndexedSpan): Promise<string | null> {
  const row = graph.db.prepare(`SELECT n.locators FROM normalized_span n JOIN search_span s USING(span_id)
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
  const normalized = graph.db.prepare("SELECT 1 FROM normalized_source WHERE transcript_id = ?").get(span.sourceId);
  if (normalized) return null;
  const legacy = graph.transcripts.list().find(t => t.sourceId === span.sourceId);
  return legacy ? readSessionText({ path: legacy.sourceKey, byteOffset: span.byteOffset, byteLength: span.byteLength, field: span.field as SpanField }) : null;
}

export interface ConversationSummary {
  sessionId: string; harness: string; nativeId: string; namespace: string;
  title: string | null; startedAt: string | null; endedAt: string | null;
  cwd: string | null; gitBranch: string | null; turnCount: number; commitCount: number | null; pushCount: number | null;
}
export function normalizedSessions(graph: SessionGraph, options: { ref?: string; limit?: number; since?: string } = {}): ConversationSummary[] {
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
