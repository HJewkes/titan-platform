import {
  computeSymbolConsumers,
  computeSymbolCoupling,
  parseSymbolId,
  type GraphNode,
  type ReferenceEdgeLite,
} from "@titan-design/code-graph";
import {
  buildBlastRadius,
  collectSymbolUtil,
  type BlastRadiusEntry,
  type NodeMetrics,
  type SymbolUtil,
} from "./dashboard-node-metrics.js";

/**
 * C-74 — deterministic per-file / per-symbol **context dossier** (Class A). A
 * pure projection of the already-computed graph: no LLM, no source re-parse. The
 * command layer (graph-context.ts) loads the snapshot and hands the assembled
 * inputs here; this module owns only the shaping + the markdown render, so it is
 * unit-testable on synthetic graphs.
 */

/** Bumped when the dossier shape changes, so a RAG store can invalidate records. */
export const SCHEMA_VERSION = "2";

export interface Provenance {
  snapshotId: number;
  ref: string;
  commitHash: string | null;
  takenAt: string;
  indexVersion: string;
}

/** `references` edges resolve cross-file imports only — flagged so a RAG query doesn't over-trust the count. */
const CONSUMER_NOTE =
  "cross-file import resolution only; intra-file and dynamic import() callers are excluded";

/**
 * Consumers split by declaring-file role (C-74/G3): for core exports most inbound
 * references are test files, which is truthful but low-signal for "what production
 * code depends on this" — so source and test consumers are separated, not flattened.
 */
export interface Consumers {
  source: string[];
  test: string[];
  counts: { source: number; test: number; total: number };
  note: string;
}

function splitConsumers(
  files: readonly string[],
  roleByFile: ReadonlyMap<string, string>,
): Consumers {
  const source: string[] = [];
  const test: string[] = [];
  for (const f of files) (roleByFile.get(f) === "test" ? test : source).push(f);
  return {
    source,
    test,
    counts: { source: source.length, test: test.length, total: files.length },
    note: CONSUMER_NOTE,
  };
}

export interface FileOwnership {
  primaryOwner: string;
  busFactor: number;
  authorCount: number;
}

/** One of a file's declared symbols, projected for the dossier. */
export interface SymbolLine {
  name: string;
  exported: boolean;
  /** One-line type signature (C-79), when indexed for this declaration. */
  signature?: string;
  cognitive?: number;
  cyclomatic?: number;
  utilization: number;
  /** Distinct files that reference this symbol (inbound `references`). */
  consumers: number;
  /**
   * Symbol-level importance (C-89): the declaring file's PageRank centrality
   * redistributed across its symbols by utilization share, so a graph-central
   * file's rank lands on the definitions actually carrying its inbound use.
   */
  importance?: number;
}

export interface SymbolDossier {
  exported: boolean;
  /** G1 slot — the type signature string, once persisted at index time. Null today. */
  signature: string | null;
  /** G2 slot — leading docstring / intent. Null today. */
  purpose: string | null;
  complexity: { cognitive?: number; cyclomatic?: number };
  utilization: number;
  consumers: Consumers;
  blastRadius: number;
  coupledWith: { symbolId: string; name: string; fileId: string; coImports: number }[];
}

export interface FileDossier {
  metrics: NodeMetrics;
  churn: { windowDays: number; value: number } | null;
  centrality: number;
  ownership: FileOwnership | null;
  symbols: SymbolLine[];
  dependsOn: string[];
  consumers: Consumers;
  blastRadius: BlastRadiusEntry[];
}

export interface ContextDossier {
  schemaVersion: string;
  target: {
    id: string;
    kind: "file" | "symbol";
    name: string;
    path: string;
    span?: { startLine: number; endLine: number };
  };
  provenance: Provenance;
  symbol?: SymbolDossier;
  file?: FileDossier;
  notes: string[];
}

export interface ContextBuildInput {
  target: GraphNode;
  kind: "file" | "symbol";
  provenance: Provenance;
  /** All nodes for the snapshot, symbols INCLUDED. */
  nodes: readonly GraphNode[];
  /** `references` edges as {srcId=importing file, dstId=symbol id}. */
  refEdges: readonly ReferenceEdgeLite[];
  /** `imports` edges as {srcId, dstId} (file → file/external). */
  importEdges: readonly { srcId: string; dstId: string }[];
  metrics: ReadonlyMap<string, NodeMetrics>;
  churnByFile: ReadonlyMap<string, number>;
  churnWindowDays: number;
  centrality: ReadonlyMap<string, number>;
  ownership: ReadonlyMap<string, FileOwnership> | null;
  /** File id → node role, for splitting consumers into source vs test (G3). */
  roleByFile: ReadonlyMap<string, string>;
}

/** Number of distinct importing files per symbol id (inbound `references`). */
function consumerCounts(
  edges: readonly ReferenceEdgeLite[],
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const c of computeSymbolConsumers(edges)) out.set(c.symbolId, c.consumers);
  return out;
}

function fileIdOf(symbolId: string): string | null {
  return parseSymbolId(symbolId)?.fileId ?? null;
}

function buildSymbolDossier(input: ContextBuildInput): SymbolDossier {
  const id = input.target.id;
  const parsed = parseSymbolId(id);
  const fileId = parsed?.fileId ?? "";
  const m = input.metrics.get(id);
  const consumers = consumerCounts(input.refEdges).get(id) ?? [];
  const complexity = m?.cognitiveMax ?? input.metrics.get(fileId)?.cognitiveMax ?? 0;
  const churn = input.churnByFile.get(fileId) ?? 0;
  const coupledWith = computeSymbolCoupling(input.refEdges)
    .filter((p) => p.aId === id || p.bId === id)
    .map((p) => (p.aId === id ? partner(p.bId, p.bName, p.bFile, p.coImports) : partner(p.aId, p.aName, p.aFile, p.coImports)))
    .slice(0, 15);
  return {
    exported: input.target.attrs?.exported !== false,
    signature: attrString(input.target.attrs?.signature),
    purpose: attrString(input.target.attrs?.purpose),
    complexity: { cognitive: m?.cognitiveMax, cyclomatic: m?.cyclomaticMax },
    utilization: m?.utilization ?? 0,
    consumers: splitConsumers(consumers, input.roleByFile),
    blastRadius: (m?.utilization ?? 0) * complexity * churn,
    coupledWith,
  };
}

function partner(symbolId: string, name: string, fileId: string, coImports: number) {
  return { symbolId, name, fileId, coImports };
}

/** A string symbol attr (signature/purpose, C-79) or null when not indexed. */
function attrString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** File's declared symbols, exports first (by utilization) then internals (by complexity). */
function fileSymbols(
  fileId: string,
  nodes: readonly GraphNode[],
  metrics: ReadonlyMap<string, NodeMetrics>,
  consumers: ReadonlyMap<string, string[]>,
): SymbolLine[] {
  const lines: (SymbolLine & { rank: number })[] = [];
  for (const n of nodes) {
    if (n.kind !== "symbol" || n.parentId !== fileId) continue;
    const m = metrics.get(n.id);
    const exported = n.attrs?.exported !== false;
    lines.push({
      name: n.name,
      exported,
      signature: attrString(n.attrs?.signature) ?? undefined,
      cognitive: m?.cognitiveMax,
      cyclomatic: m?.cyclomaticMax,
      utilization: m?.utilization ?? 0,
      consumers: (consumers.get(n.id) ?? []).length,
      rank: exported ? (m?.utilization ?? 0) : -(m?.cognitiveMax ?? 0),
    });
  }
  return sortSymbols(lines);
}

function sortSymbols(lines: (SymbolLine & { rank: number })[]): SymbolLine[] {
  const exported = lines
    .filter((l) => l.exported)
    .sort((a, b) => b.utilization - a.utilization || (b.cognitive ?? 0) - (a.cognitive ?? 0));
  const internal = lines
    .filter((l) => !l.exported)
    .sort((a, b) => (b.cognitive ?? 0) - (a.cognitive ?? 0) || a.name.localeCompare(b.name));
  return [...exported, ...internal].map(({ rank: _rank, ...line }) => line);
}

/**
 * Split the declaring file's centrality across its symbols proportional to each
 * symbol's utilization (C-89) — the file's graph importance flows onto the
 * definitions that actually carry its inbound use. When no symbol is used
 * (Σutil = 0) there is no basis to redistribute, so importance is left unset.
 */
function redistributeImportance(symbols: SymbolLine[], fileCentrality: number): SymbolLine[] {
  const totalUtil = symbols.reduce((sum, s) => sum + s.utilization, 0);
  if (totalUtil <= 0 || fileCentrality <= 0) return symbols;
  return symbols.map((s) => ({
    ...s,
    importance: Math.round(fileCentrality * (s.utilization / totalUtil) * 1e6) / 1e6,
  }));
}

function fileConsumers(fileId: string, refEdges: readonly ReferenceEdgeLite[]): string[] {
  const set = new Set<string>();
  for (const e of refEdges) if (fileIdOf(e.dstId) === fileId) set.add(e.srcId);
  return [...set].sort();
}

function fileDependsOn(
  fileId: string,
  refEdges: readonly ReferenceEdgeLite[],
  importEdges: readonly { srcId: string; dstId: string }[],
): string[] {
  const set = new Set<string>();
  for (const e of refEdges) if (e.srcId === fileId) { const f = fileIdOf(e.dstId); if (f) set.add(f); }
  for (const e of importEdges) if (e.srcId === fileId) set.add(e.dstId);
  set.delete(fileId);
  return [...set].sort();
}

function buildFileDossier(input: ContextBuildInput): FileDossier {
  const fileId = input.target.id;
  const consumers = consumerCounts(input.refEdges);
  const symbolUtil: SymbolUtil[] = collectSymbolUtil(input.nodes, input.metrics).filter((s) => s.fileId === fileId);
  const churnValue = input.churnByFile.get(fileId);
  const centrality = input.centrality.get(fileId) ?? 0;
  return {
    metrics: input.metrics.get(fileId) ?? {},
    churn: churnValue === undefined ? null : { windowDays: input.churnWindowDays, value: churnValue },
    centrality,
    ownership: input.ownership?.get(fileId) ?? null,
    symbols: redistributeImportance(
      fileSymbols(fileId, input.nodes, input.metrics, consumers),
      centrality,
    ),
    dependsOn: fileDependsOn(fileId, input.refEdges, input.importEdges),
    consumers: splitConsumers(fileConsumers(fileId, input.refEdges), input.roleByFile),
    blastRadius: buildBlastRadius(symbolUtil, input.metrics, input.churnByFile, 15),
  };
}

const SIGNATURE_NOTE =
  "Type signatures and docstrings are indexed for resolvable TypeScript declarations (C-79); a null signature means it was unannotated or unresolvable — open target.path at target.span.";

export function buildContextDossier(input: ContextBuildInput): ContextDossier {
  const { target, kind } = input;
  const span = readSpan(target);
  const path = kind === "symbol" ? (parseSymbolId(target.id)?.fileId ?? target.id) : target.id;
  const notes: string[] = [SIGNATURE_NOTE];
  if (kind === "file" && input.ownership === null) {
    notes.push("Ownership omitted (git-derived; run without --no-ownership on a repo checkout).");
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    target: { id: target.id, kind, name: target.name, path, span },
    provenance: input.provenance,
    symbol: kind === "symbol" ? buildSymbolDossier(input) : undefined,
    file: kind === "file" ? buildFileDossier(input) : undefined,
    notes,
  };
}

function readSpan(node: GraphNode): { startLine: number; endLine: number } | undefined {
  const start = node.attrs?.startLine;
  const end = node.attrs?.endLine;
  if (typeof start === "number" && typeof end === "number") return { startLine: start, endLine: end };
  return undefined;
}
