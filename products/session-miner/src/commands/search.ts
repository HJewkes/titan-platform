import { readLocatorText } from "@titan-design/locator";
import { defineCommand } from "@titan-design/registry";
import { createRetrievalEngine, ftsRetriever, graphRetriever, type FusedResult } from "@titan-design/retrieval";
import { searchText, toAbsolutePath, type SpanField } from "@titan-design/session-read";
import type { SessionGraph } from "@titan-design/session-graph";
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
  const locator = span && transcript ? { transcript: transcript.sourceKey, byteOffset: span.byteOffset, byteLength: span.byteLength, field: span.field } : null;
  return {
    ref: result.id,
    score: result.score,
    sources: result.sources,
    title: session?.ai_title ?? null,
    startedAt: session?.started_at ?? null,
    locator,
    excerpt: locator ? await excerptFor(locator) : null,
  };
}

/**
 * Read the line back through its locator and project the field's prose, the same
 * projection that was indexed. Best effort: a rotated transcript yields null.
 */
async function excerptFor(locator: NonNullable<SearchHit["locator"]>): Promise<string | null> {
  try {
    const line = await readLocatorText(toAbsolutePath(locator.transcript), [0, locator.byteOffset, locator.byteLength]);
    const parsed = JSON.parse(line) as { message?: Record<string, unknown> };
    return searchText(parsed.message ?? null, locator.field as SpanField).slice(0, EXCERPT_CHARS);
  } catch {
    return null;
  }
}
