import { contentHash, prefixHash } from "@titan-design/locator";
import type { HarnessSourcePort } from "@titan-design/agent-protocol/harness";
import { SessionSourceDescriptorSchema, SourceTextLocatorSchema, UsageMeasurementSchema } from "@titan-design/agent-protocol/source-schema";
import { expandHome, readSessionSourceText, readSessionText, SessionUsageAccumulator, type SessionUsageSummary, type SpanField } from "@titan-design/session-read";
import { hasTable } from "@titan-design/store-sqlite";
import os from "node:os";
import { z } from "zod";
import { parseDescriptorPath } from "./stored-json.js";
import type { SessionGraph } from "./graph.js";
import { stripInjected } from "./injected-text.js";

export interface IndexedSpan { sourceId: number; byteOffset: number; byteLength: number; field: string; spanId?: number }
export interface ReadIndexedTextOptions {
  homeDir?: string;
  /** An explicit port never falls back to a native reader, including for legacy spans without normalized locators. */
  sourcePort?: Pick<HarnessSourcePort, "capabilities" | "readText">;
}

/** One resolver for search and error clustering; never display a raw JSON line. */
export async function readIndexedText(graph: SessionGraph, span: IndexedSpan, options: ReadIndexedTextOptions = {}): Promise<string | null> {
  const sourcePort = options.sourcePort;
  if (sourcePort && sourcePort.capabilities.text.status !== "supported") return null;
  const text = await readSourceText(graph, span, options.homeDir ?? os.homedir(), sourcePort);
  return text !== null && span.field === "prompt" ? stripInjected(text) : text;
}

async function readSourceText(graph: SessionGraph, span: IndexedSpan, homeDir: string, sourcePort?: ReadIndexedTextOptions["sourcePort"]): Promise<string | null> {
  const row = !hasTable(graph.db, "normalized_span") ? undefined : graph.db.prepare<[number, number, string], { locators: string }>(
    `SELECT n.locators FROM normalized_span n JOIN search_span s USING(span_id)
    WHERE s.source_id = ? AND s.byte_offset = ? AND s.field = ?`).get(span.sourceId, span.byteOffset, span.field);
  if (row) {
    const source = graph.db.prepare<[number], { descriptor: string }>("SELECT descriptor FROM normalized_source WHERE transcript_id = ?").get(span.sourceId);
    if (!source) return null;
    const descriptor = parseStored(source.descriptor, SessionSourceDescriptorSchema);
    const locators = parseStored(row.locators, z.array(SourceTextLocatorSchema));
    if (!descriptor || !locators) return null;
    const watermark = graph.transcripts.list().find(t => t.sourceId === span.sourceId);
    try { if (!watermark?.prefixHash || await prefixHash(descriptor.path, watermark.lastOffset) !== watermark.prefixHash) return null; }
    catch { return null; }
    if (span.byteOffset + span.byteLength + 1 > watermark.lastOffset) {
      try { if (!watermark.contentHash || await contentHash(descriptor.path) !== watermark.contentHash) return null; } catch { return null; }
    }
    const texts = await Promise.all(locators.map(locator => {
      const options = { sources: [descriptor] };
      return sourcePort ? sourcePort.readText(locator, options) : readSessionSourceText(locator, options);
    }));
    return texts.some(text => text === null) ? null : texts.join("\n");
  }
  const normalized = hasTable(graph.db, "normalized_source") && graph.db.prepare("SELECT 1 FROM normalized_source WHERE transcript_id = ?").get(span.sourceId);
  if (normalized) return null;
  if (sourcePort) return null;
  const legacy = graph.transcripts.list().find(t => t.sourceId === span.sourceId);
  if (!legacy || !isSpanField(span.field)) return null;
  return readSessionText({ path: expandHome(legacy.sourceKey, homeDir), byteOffset: span.byteOffset, byteLength: span.byteLength, field: span.field });
}

const SPAN_FIELDS: readonly string[] = ["prompt", "assistant_response", "tool_input", "tool_result"] satisfies SpanField[];

function isSpanField(field: string): field is SpanField {
  return SPAN_FIELDS.includes(field);
}

/** A graph opened read-only may have lost its `normalized_*` tables to migration 9; every normalized reader then sees nothing. */
export function hasNormalizedTables(graph: SessionGraph): boolean {
  return hasTable(graph.db, "normalized_event") && hasTable(graph.db, "normalized_source");
}

export function countNormalizedSessions(graph: SessionGraph): number {
  if (!hasNormalizedTables(graph)) return 0;
  return graph.db.prepare<[], { n: number }>("SELECT count(DISTINCT conversation_ref) AS n FROM normalized_source").get()?.n ?? 0;
}

export function countNormalizedEvents(graph: SessionGraph): number {
  if (!hasNormalizedTables(graph)) return 0;
  return graph.db.prepare<[], { n: number }>("SELECT count(*) AS n FROM normalized_event").get()?.n ?? 0;
}

/** The transcript's own file for a normalized source, or null when the transcript is not one. */
export function normalizedSourcePath(graph: SessionGraph, transcriptId: number): string | null {
  if (!hasNormalizedTables(graph)) return null;
  const row = graph.db.prepare<[number], { descriptor: string }>("SELECT descriptor FROM normalized_source WHERE transcript_id = ?").get(transcriptId);
  return row ? parseDescriptorPath(row.descriptor) : null;
}

type ConversationParams = [string | null, string | null, string | null, string | null, number];
interface ConversationRow { ref: string; harness: string; native_id: string; namespace: string; started: string | null; turns: number }

export interface ConversationSummary {
  sessionId: string; harness: string; nativeId: string; namespace: string;
  title: string | null; startedAt: string | null; endedAt: string | null;
  cwd: string | null; gitBranch: string | null; turnCount: number; commitCount: number | null; pushCount: number | null;
}
export function normalizedSessions(graph: SessionGraph, options: { ref?: string; limit?: number; since?: string } = {}): ConversationSummary[] {
  if (!hasNormalizedTables(graph)) return [];
  const rows = graph.db.prepare<ConversationParams, ConversationRow>(`SELECT c.ref,c.harness,c.native_id,c.namespace,MIN(e.ts) AS started,
    COUNT(DISTINCT CASE WHEN e.kind = 'native_turn' THEN e.turn_ref END) AS turns
    FROM conversation c JOIN (SELECT DISTINCT conversation_ref FROM normalized_source) s ON s.conversation_ref = c.ref
    LEFT JOIN normalized_event e ON e.conversation_ref = c.ref AND e.history_origin IS NULL
    WHERE c.legacy_session_id IS NULL AND (? IS NULL OR c.ref = ?)
    GROUP BY c.ref HAVING (? IS NULL OR MIN(e.ts) >= ?)
    ORDER BY started DESC LIMIT ?`).all(options.ref ?? null,options.ref ?? null,options.since ?? null,options.since ?? null,options.limit ?? -1);
  const meta = graph.db.prepare<[string, string], { value: unknown }>(`SELECT json_extract(j.value,'$.value') AS value
    FROM normalized_event e,json_each(e.metadata) j WHERE e.conversation_ref = ?
    AND e.history_origin IS NULL AND json_extract(j.value,'$.name') = ? ORDER BY e.ts DESC,e.byte_offset DESC,e.subrecord_index DESC LIMIT 1`);
  return rows.map(c => {
    const text = (key: string) => { const value = meta.get(c.ref,key)?.value; return typeof value === "string" ? value : null; };
    return { sessionId:c.ref,harness:c.harness,nativeId:c.native_id,namespace:c.namespace,title:text("title"),startedAt:c.started,
      endedAt:null,cwd:text("cwd"),gitBranch:text("git_branch"),turnCount:c.turns,commitCount:null,pushCount:null };
  });
}

export type NormalizedUsageSummary = SessionUsageSummary;
export interface NormalizedUsageOptions {
  /** Receives one line per stored usage row that does not parse; defaults to `console.warn`. */
  warn?: (line: string) => void;
}
/** Shared storage-free usage policy keeps graph and direct readers consistent. */
export function normalizedUsage(graph: SessionGraph, ref: string, options: NormalizedUsageOptions = {}): NormalizedUsageSummary[] {
  if (!hasNormalizedTables(graph)) return [];
  // Snapshot epochs are local to a physical source; never add copies from different files.
  // Pick the source with the latest native timestamp (then fullest coverage, then stable ID).
  const preferred = graph.db.prepare<[string], { transcript_id: number }>(`SELECT transcript_id FROM normalized_event
    WHERE conversation_ref = ? AND usage IS NOT NULL AND history_origin IS NULL
    GROUP BY transcript_id ORDER BY MAX(ts) DESC, COUNT(*) DESC, transcript_id ASC LIMIT 1`).get(ref);
  const rows = graph.db.prepare<[string, number], { usage: string }>(`SELECT usage FROM normalized_event WHERE conversation_ref = ?
    AND usage IS NOT NULL AND history_origin IS NULL
    AND (json_extract(usage,'$.kind') = 'delta' OR transcript_id = ?)
    ORDER BY byte_offset,subrecord_index`);
  const warn = options.warn ?? (line => { console.warn(line); });
  const accumulator = new SessionUsageAccumulator();
  for (const row of rows.iterate(ref, preferred?.transcript_id ?? -1)) {
    const usage = parseStored(row.usage, UsageMeasurementSchema);
    // A skipped row understates cost, so say so rather than drop it silently.
    if (usage) accumulator.add(usage);
    else warn(`session-graph: skipping an unreadable usage row in ${ref}; its cost is not counted`);
  }
  return accumulator.summaries();
}

/** A stored JSON column narrowed by its schema; null when it is not JSON or does not match. */
function parseStored<T>(json: string, schema: z.ZodType<T>): T | null {
  let value: unknown;
  try { value = JSON.parse(json); } catch { return null; }
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

interface TurnRow { turn_ref: string; started: string | null; ended: string | null; tool_calls: number }

export interface NormalizedTurn { turnRef: string; startedAt: string | null; endedAt: string | null; toolCalls: number }
export interface NormalizedConversationDetail {
  turns: NormalizedTurn[];
  edges: { relation: string; targetRef: string }[];
  inbound: { relation: string; sourceRef: string }[];
}
/** Turns in start order with their distinct tool calls, plus lineage both ways. */
export function normalizedConversationDetail(graph: SessionGraph, ref: string): NormalizedConversationDetail {
  if (!hasNormalizedTables(graph)) return { turns: [], edges: [], inbound: [] };
  const turns = graph.db.prepare<[string, string], TurnRow>(`SELECT t.turn_ref,t.started,t.ended,COALESCE(c.n,0) AS tool_calls
    FROM (SELECT turn_ref,MIN(ts) AS started,MAX(ts) AS ended FROM normalized_event
      WHERE conversation_ref = ? AND history_origin IS NULL AND kind = 'native_turn' GROUP BY turn_ref) t
    LEFT JOIN (SELECT turn_ref,count(DISTINCT call_ref) AS n FROM normalized_event
      WHERE conversation_ref = ? AND history_origin IS NULL AND kind = 'tool_call' GROUP BY turn_ref) c USING(turn_ref)
    ORDER BY t.started,t.turn_ref`).all(ref, ref);
  const edges = graph.db.prepare<[string], { relationship: string; related_ref: string }>("SELECT DISTINCT relationship,related_ref FROM normalized_event WHERE conversation_ref = ? AND kind = 'lineage'").all(ref);
  const inbound = graph.db.prepare<[string], { relationship: string; conversation_ref: string }>("SELECT DISTINCT relationship,conversation_ref FROM normalized_event WHERE related_ref = ? AND kind = 'lineage'").all(ref);
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
  return graph.db.prepare<[], NormalizedErrorFact>(`SELECT n.transcript_id AS transcriptId,n.byte_offset AS byteOffset,MAX(n.byte_length) AS byteLength,
      n.conversation_ref AS conversationRef,COALESCE(MIN(n.ts),t.created_at) AS ts,t.source_key AS path,
      COALESCE(t.content_hash,t.prefix_hash,'') AS sourceHash
    FROM normalized_event n JOIN transcript t ON t.source_id = n.transcript_id
    WHERE n.kind = 'tool_result' AND n.is_error IS NOT 0 AND t.status = 'ok'
    GROUP BY n.transcript_id,n.byte_offset ORDER BY ts`).all();
}
