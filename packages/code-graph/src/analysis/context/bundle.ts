import { readFileSync } from "node:fs";
import * as path from "node:path";
import {
  parseSymbolId,
  type GraphEdge,
  type GraphNode,
} from "@titan-design/code-graph";
import type { ContextDossier } from "./graph-context-build.js";
import { renderContextMarkdown } from "./graph-context-format.js";

/**
 * C-80 — the **context bundle**: one deterministic pull of the complete paired
 * context for a symbol/file, the push half of the ingestion API. It wraps the
 * C-74 dossier with the three things an ingestor needs to embed/answer WITHOUT
 * opening the file: the raw **source chunk** (source text of the span), the
 * resolved **graph linkages as explicit edges** (callers / dependencies /
 * coupled-with — not just counts), and **coverage** (C-63, when the overlay is
 * ingested). No LLM; a pure projection of the graph + the working-tree source.
 */
export const BUNDLE_SCHEMA_VERSION = "2";

export interface SourceChunk {
  /** Repo-relative file id the chunk was read from. */
  path: string;
  /** 1-based inclusive line span for a symbol; null for a whole-file target. */
  span: { startLine: number; endLine: number } | null;
  /** The source text, or null when the file could not be read. */
  text: string | null;
  note?: string;
}

/** A resolved graph linkage, deterministic and directional relative to the target. */
export interface BundleEdge {
  from: string;
  to: string;
  kind: string;
  weight: number;
  /**
   * Seeded-PageRank relevance of this edge's neighbour to the target (C-89).
   * Present only when the target was seeded (the bundle path); the neighbour is
   * whichever endpoint is not the target's file. Edges are ordered by it, so the
   * most target-relevant linkages lead, not the globally-famous ones.
   */
  relevance?: number;
}

export interface BundleEdges {
  /** Inbound — who references/imports the target. */
  callers: BundleEdge[];
  /** Outbound — what the target references/imports. */
  dependencies: BundleEdge[];
  /** Co-import coupling partners (symbol targets only). */
  coupledWith: BundleEdge[];
  note: string;
}

export interface Coverage {
  pct: number | null;
  note?: string;
}

export interface ContextBundle {
  schemaVersion: string;
  dossier: ContextDossier;
  source: SourceChunk;
  edges: BundleEdges;
  coverage: Coverage;
}

export interface BundleBuildInput {
  dossier: ContextDossier;
  target: GraphNode;
  kind: "file" | "symbol";
  /** Weighted `references` edges (srcId = importing file → dstId = symbol id). */
  refEdges: readonly GraphEdge[];
  /** Weighted `imports` edges (file → file/external). */
  importEdges: readonly GraphEdge[];
  /** Git toplevel to resolve the source path, or null (read relative to cwd). */
  repoRoot: string | null;
  /** `coverage_pct` for the target node, or null when the overlay is absent. */
  coveragePct: number | null;
  /** File id → seeded-relevance score (C-89); absent/empty ⇒ weight-ordered cold path. */
  relevanceByFile?: ReadonlyMap<string, number>;
  /** The target's declaring file id, for locating each edge's neighbour (C-89). */
  targetFileId?: string;
}

const EDGE_NOTE =
  "references resolve cross-file import usage (src = importing file → dst = symbol); a symbol's dependencies are its declaring file's outbound edges (the graph resolves the source side at file granularity).";
const COVERAGE_NOTE =
  "coverage_pct overlay not ingested; run `graph coverage <istanbul-report>` to populate.";
const SOURCE_READ_NOTE = "source file could not be read from the working tree at this path.";

function weightOf(e: GraphEdge): number {
  const w = e.attrs?.weight;
  return typeof w === "number" ? w : 1;
}

/** Seeded-relevance ranking context, or null on the no-seed cold path. */
interface RelevanceCtx {
  relevanceByFile: ReadonlyMap<string, number>;
  targetFileId: string;
}

function relevanceCtx(input: BundleBuildInput): RelevanceCtx | null {
  const { relevanceByFile, targetFileId } = input;
  if (!relevanceByFile || relevanceByFile.size === 0 || targetFileId === undefined) return null;
  return { relevanceByFile, targetFileId };
}

/** File that declares a node (itself for a file, its parent for a symbol). */
function fileOf(id: string): string {
  return parseSymbolId(id)?.fileId ?? id;
}

/**
 * Order the edges. With a seed (bundle path) rank by relevance-to-target — the
 * seeded-PageRank score of whichever endpoint is not the target's file — so the
 * closest linkages lead; without one, fall back to raw edge weight (global fame).
 */
function rankEdges(edges: BundleEdge[], ctx: RelevanceCtx | null): BundleEdge[] {
  if (!ctx) return sortByWeight(edges);
  const annotated = edges.map((e) => {
    const neighbor = fileOf(e.from) === ctx.targetFileId ? fileOf(e.to) : fileOf(e.from);
    return { ...e, relevance: round4(ctx.relevanceByFile.get(neighbor) ?? 0) };
  });
  return annotated.sort(
    (a, b) =>
      (b.relevance ?? 0) - (a.relevance ?? 0) ||
      b.weight - a.weight ||
      a.from.localeCompare(b.from) ||
      a.to.localeCompare(b.to),
  );
}

function sortByWeight(edges: BundleEdge[]): BundleEdge[] {
  return edges.sort(
    (a, b) => b.weight - a.weight || a.from.localeCompare(b.from) || a.to.localeCompare(b.to),
  );
}

function round4(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/** Explicit resolved edges for a symbol target: inbound refs, its file's outbound refs, coupling. */
function symbolEdges(input: BundleBuildInput): BundleEdges {
  const id = input.target.id;
  const fileId = parseSymbolId(id)?.fileId ?? "";
  const ctx = relevanceCtx(input);
  const callers = input.refEdges
    .filter((e) => e.dstId === id)
    .map((e) => ({ from: e.srcId, to: id, kind: "references", weight: weightOf(e) }));
  const dependencies = [
    ...input.refEdges.filter((e) => e.srcId === fileId).map((e) => edge(e, "references")),
    ...input.importEdges.filter((e) => e.srcId === fileId).map((e) => edge(e, "imports")),
  ];
  const coupledWith = (input.dossier.symbol?.coupledWith ?? []).map((c) => ({
    from: id,
    to: c.symbolId,
    kind: "coupled-with",
    weight: c.coImports,
  }));
  return {
    callers: rankEdges(callers, ctx),
    dependencies: rankEdges(dependencies, ctx),
    coupledWith: rankEdges(coupledWith, ctx),
    note: EDGE_NOTE,
  };
}

/** Explicit resolved edges for a file target: inbound + outbound refs and imports. */
function fileEdges(input: BundleBuildInput): BundleEdges {
  const id = input.target.id;
  const ctx = relevanceCtx(input);
  const inbound = (e: GraphEdge) => parseSymbolId(e.dstId)?.fileId === id;
  const callers = [
    ...input.refEdges.filter(inbound).map((e) => edge(e, "references")),
    ...input.importEdges.filter((e) => e.dstId === id).map((e) => edge(e, "imports")),
  ];
  const dependencies = [
    ...input.refEdges.filter((e) => e.srcId === id).map((e) => edge(e, "references")),
    ...input.importEdges.filter((e) => e.srcId === id).map((e) => edge(e, "imports")),
  ];
  return {
    callers: rankEdges(callers, ctx),
    dependencies: rankEdges(dependencies, ctx),
    coupledWith: [],
    note: EDGE_NOTE,
  };
}

function edge(e: GraphEdge, kind: string): BundleEdge {
  return { from: e.srcId, to: e.dstId, kind, weight: weightOf(e) };
}

function readSource(input: BundleBuildInput): SourceChunk {
  const filePath =
    input.kind === "symbol" ? (parseSymbolId(input.target.id)?.fileId ?? input.target.id) : input.target.id;
  const span = input.dossier.target.span ?? null;
  const abs = input.repoRoot ? path.join(input.repoRoot, filePath) : filePath;
  try {
    const content = readFileSync(abs, "utf8");
    const text = span ? sliceSpan(content, span) : content;
    return { path: filePath, span, text };
  } catch {
    return { path: filePath, span, text: null, note: SOURCE_READ_NOTE };
  }
}

/** 1-based inclusive line slice. */
function sliceSpan(content: string, span: { startLine: number; endLine: number }): string {
  return content.split("\n").slice(span.startLine - 1, span.endLine).join("\n");
}

export function buildContextBundle(input: BundleBuildInput): ContextBundle {
  return {
    schemaVersion: BUNDLE_SCHEMA_VERSION,
    dossier: input.dossier,
    source: readSource(input),
    edges: input.kind === "symbol" ? symbolEdges(input) : fileEdges(input),
    coverage: {
      pct: input.coveragePct,
      note: input.coveragePct === null ? COVERAGE_NOTE : undefined,
    },
  };
}

/** Concatenated text projection — hand this straight to an embedder/LLM. */
export function renderBundleText(bundle: ContextBundle): string {
  const cov = bundle.coverage.pct === null ? "—" : `${bundle.coverage.pct}%`;
  return [
    renderContextMarkdown(bundle.dossier),
    "## Coverage",
    `- **coverage**: ${cov}`,
    "",
    ...renderEdgeSection("Callers (inbound)", bundle.edges.callers),
    ...renderEdgeSection("Dependencies (outbound)", bundle.edges.dependencies),
    ...renderEdgeSection("Coupled with", bundle.edges.coupledWith),
    "## Source",
    "```typescript",
    bundle.source.text ?? `// ${bundle.source.note ?? "unavailable"}`,
    "```",
    "",
  ].join("\n");
}

function renderEdgeSection(title: string, edges: readonly BundleEdge[]): string[] {
  if (!edges.length) return [];
  return [`### ${title}`, ...edges.map(renderEdgeLine), ""];
}

function renderEdgeLine(e: BundleEdge): string {
  const rel = e.relevance !== undefined ? `, rel ${e.relevance}` : "";
  return `- \`${e.from}\` → \`${e.to}\` (${e.kind} ×${e.weight}${rel})`;
}
