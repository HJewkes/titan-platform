import { defineCommand } from "@titan-design/registry";
import { createRetrievalEngine, ftsRetriever, graphRetriever, type FusedResult } from "@titan-design/retrieval";
import { normalizedSessions, readIndexedText, type SessionGraph } from "@titan-design/session-graph";
import { z } from "zod";
import type { MinerContext } from "../context.js";

const SearchArgs = z.object({
  query: z.string().min(1),
  limit: z.number().int().positive().max(100).default(10),
});

export interface SearchHit {
  ref: string;
  score: number;
  sources: string[];
  title: string | null;
  startedAt: string | null;
  /** Where the matching text lives; null for graph-only hits. */
  locator: { transcript: string; byteOffset: number; byteLength: number; field: string } | null;
  /** The first part of the matching line, read back through the locator. */
  excerpt: string | null;
}

export interface SearchResponse {
  hits: SearchHit[];
  degraded: { retriever: string; reason: string; message: string }[];
}

const EXCERPT_CHARS = 240;

export const search = defineCommand<z.infer<typeof SearchArgs>, SearchResponse, MinerContext>({
  name: "search",
  description: "Full-text search over prompts, responses, and tool output, expanded through the session graph",
  args: SearchArgs,
  result: z.custom<SearchResponse>(),
  cli: { positional: ["query"], options: { limit: { long: "--limit", short: "-n", description: "max hits" } } },
  async run(args, ctx) {
    const graph = ctx.graph();
    const fts = ftsRetriever(graph.spans);
    const engine = createRetrievalEngine({ retrievers: [fts, graphRetriever(graph.edges, fts, { seedLimit: 3, hops: 1 })], timeoutMs: 5_000 });
    const { results, degraded } = await engine.search(args.query, { limit: args.limit });
    const hits = await Promise.all(results.map((r) => toHit(graph, r)));
    return { hits, degraded };
  },
});

async function toHit(graph: SessionGraph, result: FusedResult): Promise<SearchHit> {
  const session = graph.db.prepare("SELECT ai_title, started_at FROM session WHERE session_id = ?").get(result.id.replace(/^session:/, "")) as
    | { ai_title: string | null; started_at: string | null }
    | undefined;
  const span = result.payloads.fts as { sourceId: number; byteOffset: number; byteLength: number; field: string } | undefined;
  const transcript = span ? graph.transcripts.list().find((t) => t.sourceId === span.sourceId) : undefined;
  const normalizedSource = span ? graph.db.prepare("SELECT descriptor FROM normalized_source WHERE transcript_id = ?").get(span.sourceId) as { descriptor: string } | undefined : undefined;
  const sourcePath = normalizedSource ? (JSON.parse(normalizedSource.descriptor) as { path: string }).path : transcript?.sourceKey;
  const locator = span && sourcePath ? { transcript: sourcePath, byteOffset: span.byteOffset, byteLength: span.byteLength, field: span.field } : null;
  const normalized = result.id.startsWith("conversation:") ? normalizedSessions(graph, { ref: result.id, limit: 1 })[0] : undefined;
  return {
    ref: result.id,
    score: result.score,
    sources: result.sources,
    title: session?.ai_title ?? normalized?.title ?? null,
    startedAt: session?.started_at ?? normalized?.startedAt ?? null,
    locator,
    excerpt: span ? (await readIndexedText(graph, span))?.slice(0, EXCERPT_CHARS) ?? null : null,
  };
}
