import { Clusterer, hasErrorSignal, type ClustererSnapshot } from "@titan-design/cluster";
import { defineCommand } from "@titan-design/registry";
import { readIndexedText, type SessionGraph } from "@titan-design/session-graph";
import { nowIso } from "@titan-design/store-sqlite";
import { z } from "zod";
import type { MinerContext } from "../context.js";

/** Error blobs are partitioned as one tool type until tool names are threaded through facts. */
const PARTITION = "tool_result";

export interface DrainSummary {
  candidates: number;
  screened: number;
  clustered: number;
  newTemplates: number;
  templates: number;
  unreadable: number;
}

interface ErrorFact {
  fact_id: number;
  transcript_id: number;
  byte_offset: number;
  byte_length: number;
  session_id: string;
  ts: string;
  path: string;
  source_hash: string;
}

const DrainArgs = z.object({ limit: z.number().int().positive().optional().describe("Cluster at most this many new error blobs") });

export const drainIngest = defineCommand<z.infer<typeof DrainArgs>, DrainSummary, MinerContext>({
  name: "drain.ingest",
  description: "Cluster tool-result errors into recurring failure templates",
  args: DrainArgs,
  result: z.custom<DrainSummary>(),
  cli: { options: { limit: { long: "--limit", short: "-n", description: "max blobs" } } },
  async run(args, ctx) {
    const graph = ctx.graph();
    const clusterer = loadClusterer(graph);
    const summary: DrainSummary = { candidates: 0, screened: 0, clustered: 0, newTemplates: 0, templates: 0, unreadable: 0 };
    for (const fact of pendingErrorFacts(graph, args.limit)) {
      summary.candidates += 1;
      const text = await readIndexedText(graph, { sourceId: fact.transcript_id, byteOffset: fact.byte_offset, byteLength: fact.byte_length, field: "tool_result" });
      if (text === null) {
        summary.unreadable += 1;
        continue;
      }
      if (!hasErrorSignal(PARTITION, text)) {
        summary.screened += 1;
        graph.db.prepare("INSERT OR IGNORE INTO drain_screened VALUES (?,?,?)").run(fact.transcript_id, fact.byte_offset, fact.source_hash);
        continue;
      }
      const result = clusterer.cluster({ partition: PARTITION, text });
      recordOccurrence(graph, fact, result.templateId, result.maskedSignature, result.extractedParams);
      summary.clustered += 1;
      if (result.isNewTemplate) summary.newTemplates += 1;
    }
    saveClusterer(graph, clusterer);
    summary.templates = (graph.db.prepare("SELECT count(*) AS n FROM template").get() as { n: number }).n;
    return summary;
  },
});

/** Error facts not yet clustered, joined to their transcript path. */
function pendingErrorFacts(graph: SessionGraph, limit?: number): ErrorFact[] {
  return graph.db
    .prepare(
      `SELECT f.fact_id, f.transcript_id, f.byte_offset, f.byte_length, f.session_id, f.ts, t.source_key AS path, COALESCE(t.content_hash,t.prefix_hash,'') AS source_hash
       FROM fact f JOIN transcript t ON t.source_id = f.transcript_id
       LEFT JOIN occurrence o ON o.transcript_id = f.transcript_id AND o.byte_offset = f.byte_offset
       LEFT JOIN drain_screened d ON d.transcript_id = f.transcript_id AND d.byte_offset = f.byte_offset AND d.source_hash = COALESCE(t.content_hash,t.prefix_hash,'')
       WHERE f.event_type = 'tool_result_error' AND o.template_id IS NULL AND d.transcript_id IS NULL AND t.status = 'ok'
       UNION ALL
       SELECT 0 AS fact_id,n.transcript_id,n.byte_offset,MAX(n.byte_length),n.conversation_ref AS session_id,COALESCE(MIN(n.ts),t.created_at) AS ts,t.source_key AS path, COALESCE(t.content_hash,t.prefix_hash,'') AS source_hash
       FROM normalized_event n JOIN transcript t ON t.source_id = n.transcript_id
       LEFT JOIN occurrence o ON o.transcript_id = n.transcript_id AND o.byte_offset = n.byte_offset
       LEFT JOIN drain_screened d ON d.transcript_id = n.transcript_id AND d.byte_offset = n.byte_offset AND d.source_hash = COALESCE(t.content_hash,t.prefix_hash,'')
       WHERE n.kind = 'tool_result' AND n.is_error IS NOT 0 AND o.template_id IS NULL AND d.transcript_id IS NULL AND t.status = 'ok'
       GROUP BY n.transcript_id,n.byte_offset
       ORDER BY ts LIMIT ?`,
    )
    .all(limit ?? -1) as ErrorFact[];
}

function recordOccurrence(graph: SessionGraph, fact: ErrorFact, templateId: string, maskedSignature: string, params: Record<string, string>): void {
  graph.db
    .prepare(
      `INSERT INTO template (template_id, partition, masked_signature, created_at, occurrence_count, exemplar_transcript_id, exemplar_byte_offset, exemplar_byte_length)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?)
       ON CONFLICT (template_id) DO UPDATE SET occurrence_count = occurrence_count + 1`,
    )
    .run(templateId, PARTITION, maskedSignature, fact.ts, fact.transcript_id, fact.byte_offset, fact.byte_length);
  graph.db
    .prepare("INSERT INTO occurrence (template_id, transcript_id, byte_offset, byte_length, session_id, ts, params) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING")
    .run(templateId, fact.transcript_id, fact.byte_offset, fact.byte_length, fact.session_id, fact.ts, Object.keys(params).length ? JSON.stringify(params) : null);
}

function loadClusterer(graph: SessionGraph): Clusterer {
  const row = graph.db.prepare("SELECT snapshot FROM clusterer_snapshot WHERE id = 1").get() as { snapshot: string } | undefined;
  return row ? Clusterer.fromSnapshot(JSON.parse(row.snapshot) as ClustererSnapshot) : new Clusterer();
}

function saveClusterer(graph: SessionGraph, clusterer: Clusterer): void {
  graph.db
    .prepare("INSERT INTO clusterer_snapshot (id, snapshot, saved_at) VALUES (1, ?, ?) ON CONFLICT (id) DO UPDATE SET snapshot = excluded.snapshot, saved_at = excluded.saved_at")
    .run(JSON.stringify(clusterer.snapshot()), nowIso());
}

export interface TemplateRow {
  templateId: string;
  maskedSignature: string;
  occurrenceCount: number;
  createdAt: string;
}

export const drainTemplates = defineCommand<{ limit: number }, TemplateRow[], MinerContext>({
  name: "drain.templates",
  description: "Recurring failure templates, most frequent first",
  args: z.object({ limit: z.number().int().positive().max(500).default(20) }),
  result: z.custom<TemplateRow[]>(),
  cli: { options: { limit: { long: "--limit", short: "-n", description: "max templates" } } },
  async run(args, ctx) {
    const rows = ctx.graph().db.prepare("SELECT template_id, masked_signature, occurrence_count, created_at FROM template ORDER BY occurrence_count DESC, created_at LIMIT ?").all(args.limit) as Record<string, unknown>[];
    return rows.map((r) => ({ templateId: r.template_id as string, maskedSignature: r.masked_signature as string, occurrenceCount: r.occurrence_count as number, createdAt: r.created_at as string }));
  },
});
