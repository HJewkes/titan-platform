import { createHash } from "node:crypto";
import type { Node } from "web-tree-sitter";
import { getLanguageFromPath, parseFile, type ParsedFile } from "@titan-design/code-parser";
import type { CodeGraphStore } from "./store.js";
import { workingTreeSource, type IndexSource } from "./index-source.js";
import { fileId, parseSymbolId } from "./extractors/ids.js";
import { SOURCE_METRIC_NAMES } from "./source-metrics.js";
import { DEAD_CODE_METRIC_NAMES } from "./analysis/dead-code.js";
import { GROWTH_RISK_METRIC_NAMES } from "./analysis/growth-risk.js";
import { reconstructCosmetic, reconstructFragment } from "./reconstruct.js";
import { digestParsedFile, type FileDigest } from "./file-digest.js";
import type { Extractor } from "@titan-design/code-parser";
import type {
  FileFingerprint,
  GraphEdge,
  GraphFragment,
  GraphMetric,
  GraphNode,
} from "./types.js";

/** SHA-256 of file content. The fingerprint that gates per-file reuse. */
export function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Comment/whitespace-insensitive hash of a file's parse structure (C-18). Walks
 * the tree-sitter tree emitting each node's type plus leaf text, skipping comment
 * nodes; whitespace and positions are absent from the tree, so a pure reformat or
 * comment edit yields the SAME signature while any token change yields a new one.
 * Two files with an equal signature therefore produce identical edges and AST
 * metrics and differ only in line spans (and loc) — the COSMETIC reuse class.
 */
export function structuralSignature(file: ParsedFile): string {
  const parts: string[] = [];
  const visit = (node: Node): void => {
    if (node.type === "comment") return;
    parts.push(node.type);
    if (node.childCount === 0) parts.push(node.text);
    for (const child of node.children) if (child) visit(child);
  };
  visit(file.tree.rootNode);
  return hashContent(parts.join(""));
}

/** The languages that have an extractor; anything else is skipped by the walk. */
export type SourceLanguage = "typescript" | "python";

export interface ReadFile {
  filePath: string;
  language: SourceLanguage;
  content: string;
  hash: string;
}

function sourceLanguage(filePath: string): SourceLanguage | null {
  const language = getLanguageFromPath(filePath);
  return language === "typescript" || language === "python" ? language : null;
}

/** Read + hash every source file. Cheap I/O; the parse/extract it gates is not. */
export async function readSourceFiles(
  filePaths: readonly string[],
  source: IndexSource = workingTreeSource(),
): Promise<ReadFile[]> {
  const out: ReadFile[] = [];
  for (const filePath of filePaths) {
    const language = sourceLanguage(filePath);
    if (language === null) continue;
    const content = source.readFile(filePath);
    out.push({ filePath, language, content, hash: hashContent(content) });
  }
  return out;
}

/**
 * Split files into those to (re)parse and those reusable from the prior snapshot.
 * A file is reused when its content hash matches AND it is not in `affected` — the
 * set (C-20) whose edges a file-membership delta changed, which must re-extract
 * despite being byte-identical. `affected` is empty when membership is unchanged.
 */
export function classifyForReuse(
  readFiles: readonly ReadFile[],
  idRoot: string,
  reuse: ReuseBasis | null,
  affected: ReadonlySet<string> = new Set(),
): { toParse: ReadFile[]; reusedFileIds: string[] } {
  const toParse: ReadFile[] = [];
  const reusedFileIds: string[] = [];
  for (const rf of readFiles) {
    const id = fileId(idRoot, rf.filePath);
    if (reuse && reuse.fingerprints.get(id) === rf.hash && !affected.has(id)) {
      reusedFileIds.push(id);
    } else {
      toParse.push(rf);
    }
  }
  return { toParse, reusedFileIds };
}

/**
 * The `changed` ids whose structure differs from the basis, plus removed ones. A
 * COSMETIC edit yields the same edges and so the same export surface, which
 * keeps its importers reusable; deciding that costs a tree-sitter parse of each
 * changed file, far less than the ts-morph extract of every importer. Each tree
 * is deleted before the next parse (TP-747).
 */
export async function structurallyChanged(
  readFiles: readonly ReadFile[],
  idRoot: string,
  reuse: ReuseBasis,
  changed: ReadonlySet<string>,
): Promise<Set<string>> {
  const out = new Set(changed);
  for (const rf of readFiles) {
    const id = fileId(idRoot, rf.filePath);
    const basisSig = reuse.structuralHashes.get(id);
    if (!changed.has(id) || basisSig === undefined) continue;
    const parsed = await parseFile(rf.content, rf.filePath, rf.language);
    try {
      if (structuralSignature(parsed) === basisSig) out.delete(id);
    } finally {
      parsed.tree.delete();
    }
  }
  return out;
}

/** What the per-file stream leaves behind once every tree it parsed is deleted. */
export interface StreamedFiles {
  /** Every file's fragments in walk order, so the merge dedup resolves shared nodes as a full index does. */
  fragments: GraphFragment[];
  /** Parsed files whose structure matches the basis — reuse edges, skip extract. */
  cosmeticFileIds: Set<string>;
  /** fileId → structural signature, for every parsed file and every reused file. */
  structuralByFileId: Map<string, string>;
  /** Tree-derived metrics and qualified names of each parsed file, in walk order; empty unless asked for. */
  digests: FileDigest[];
}

export interface StreamFilesInput {
  readFiles: readonly ReadFile[];
  idRoot: string;
  toParse: readonly ReadFile[];
  reuse: ReuseBasis | null;
  reusedFileIds: readonly string[];
  affected: ReadonlySet<string>;
  extractor: Extractor<GraphFragment>;
  /** Digest each parsed file; skip when neither metrics nor requalify aliases will read the digests. */
  digest: boolean;
}

/**
 * Build fragments for all files in walk order. Each file to parse is parsed,
 * structurally signed (C-18), extracted — or, when COSMETIC, reconstructed from
 * the basis with refreshed line spans — digested, and its tree deleted before
 * the next parse, so at most one web-tree-sitter tree is alive at a time
 * (TP-747: WASM memory never shrinks, so the peak is set by live trees). Reused
 * files are reconstructed from the basis without a parse.
 */
export async function streamFiles(input: StreamFilesInput): Promise<StreamedFiles> {
  const toParse = new Set(input.toParse.map((rf) => rf.filePath));
  const out: StreamedFiles = { fragments: [], cosmeticFileIds: new Set(), structuralByFileId: new Map(), digests: [] };
  for (const rf of input.readFiles) {
    const id = fileId(input.idRoot, rf.filePath);
    if (toParse.has(rf.filePath)) {
      await streamParsedFile(input, rf, id, out);
    } else if (input.reuse) {
      out.fragments.push(reconstructFragment(input.idRoot, rf.filePath, id, input.reuse));
    }
  }
  carryReusedSignatures(input.reuse, input.reusedFileIds, out.structuralByFileId);
  return out;
}

async function streamParsedFile(input: StreamFilesInput, rf: ReadFile, id: string, out: StreamedFiles): Promise<void> {
  const parsed = await parseFile(rf.content, rf.filePath, rf.language);
  try {
    const sig = structuralSignature(parsed);
    out.structuralByFileId.set(id, sig);
    const basis = cosmeticBasis(input, id, sig);
    const fragments = basis
      ? [reconstructCosmetic(input.idRoot, rf.filePath, id, basis, parsed)]
      : input.extractor.extract(parsed);
    if (basis) out.cosmeticFileIds.add(id);
    out.fragments.push(...fragments);
    if (input.digest) out.digests.push(digestParsedFile(parsed, id, ownSymbolNames(fragments, id)));
  } finally {
    parsed.tree.delete();
  }
}

/**
 * The basis to reconstruct from when the file is COSMETIC, else null. A file
 * affected by a membership delta (C-20) has a stale basis edge set even though
 * its structure is unchanged, so it must NOT take the cosmetic path.
 */
function cosmeticBasis(input: StreamFilesInput, id: string, sig: string): ReuseBasis | null {
  const { reuse, affected } = input;
  return reuse && !affected.has(id) && reuse.structuralHashes.get(id) === sig ? reuse : null;
}

/** Names of the symbol nodes a file's own fragments declare; symbols always hang off their declaring file. */
function ownSymbolNames(fragments: readonly GraphFragment[], id: string): Set<string> {
  const names = new Set<string>();
  for (const fragment of fragments) {
    for (const n of fragment.nodes) if (n.kind === "symbol" && n.parentId === id) names.add(n.name);
  }
  return names;
}

/** Reused (NONE-tier) files keep their signatures, so they survive across generations rather than decaying to NULL. */
function carryReusedSignatures(
  reuse: ReuseBasis | null,
  reusedFileIds: readonly string[],
  structuralByFileId: Map<string, string>,
): void {
  if (!reuse) return;
  for (const id of reusedFileIds) {
    const sig = reuse.structuralHashes.get(id);
    if (sig !== undefined) structuralByFileId.set(id, sig);
  }
}

/**
 * One fingerprint per file (content hash + C-18 structural signature), to persist
 * for the next run to diff against. The structural signature is looked up per
 * file; a file with none (e.g. a non-TS file, or a reuse carried from a pre-C-18
 * basis) stores NULL and simply can't take the cosmetic path next time.
 */
export function buildFingerprints(
  readFiles: readonly ReadFile[],
  idRoot: string,
  structuralByFileId: ReadonlyMap<string, string>,
): FileFingerprint[] {
  return readFiles.map((rf) => {
    const id = fileId(idRoot, rf.filePath);
    return {
      fileId: id,
      contentHash: rf.hash,
      structuralHash: structuralByFileId.get(id),
    };
  });
}

/**
 * Everything from a prior snapshot needed to rebuild an unchanged file's
 * contribution to the graph without re-parsing it: its content fingerprint,
 * the node table (to look up external-node names), outbound edges grouped by
 * source file (a symbol's `calls` edges under the file declaring it), and the source-content metrics (loc, complexity, lcom4, ...).
 */
export interface ReuseBasis {
  snapshotId: number;
  fingerprints: Map<string, string>;
  /** Per-file structural signature (C-18); empty for a pre-C-18 basis. */
  structuralHashes: Map<string, string>;
  nodesById: Map<string, GraphNode>;
  edgesBySrc: Map<string, GraphEdge[]>;
  sourceMetricsByFile: Map<string, GraphMetric[]>;
  /** Symbol nodes grouped by their declaring file id, to carry forward for reused files (C-53). */
  symbolsByFile: Map<string, GraphNode[]>;
}

function pushBucket<V>(buckets: Map<string, V[]>, key: string, value: V): void {
  const bucket = buckets.get(key);
  if (bucket) bucket.push(value);
  else buckets.set(key, [value]);
}

function indexNodes(nodes: readonly GraphNode[]): {
  nodesById: Map<string, GraphNode>;
  symbolsByFile: Map<string, GraphNode[]>;
} {
  const nodesById = new Map<string, GraphNode>();
  const symbolsByFile = new Map<string, GraphNode[]>();
  for (const n of nodes) {
    nodesById.set(n.id, n);
    if (n.kind === "symbol" && n.parentId) pushBucket(symbolsByFile, n.parentId, n);
  }
  return { nodesById, symbolsByFile };
}

function groupEdgesBySource(edges: readonly GraphEdge[]): Map<string, GraphEdge[]> {
  const edgesBySrc = new Map<string, GraphEdge[]>();
  for (const e of edges) {
    // A `calls` edge leaves a symbol (TP-323); file it under the declaring file so reuse carries it.
    pushBucket(edgesBySrc, parseSymbolId(e.srcId)?.fileId ?? e.srcId, e);
  }
  return edgesBySrc;
}

// Source-content, dead-code, and growth-risk metrics are pure functions of
// a file's bytes, so they carry forward verbatim for an unchanged file.
function isCarriedMetric(name: string): boolean {
  return (
    SOURCE_METRIC_NAMES.has(name) ||
    DEAD_CODE_METRIC_NAMES.has(name) ||
    GROWTH_RISK_METRIC_NAMES.has(name)
  );
}

// Per-symbol metrics (C-58) live on `<fileId>#<name>` nodes; bucket them
// under their parent file so an unchanged file carries its symbol
// complexity forward alongside its file-level source metrics.
function metricFileKey(m: GraphMetric, nodesById: ReadonlyMap<string, GraphNode>): string {
  const node = nodesById.get(m.nodeId);
  return node?.kind === "symbol" && node.parentId ? node.parentId : m.nodeId;
}

function groupSourceMetrics(
  metrics: readonly GraphMetric[],
  nodesById: ReadonlyMap<string, GraphNode>,
): Map<string, GraphMetric[]> {
  const sourceMetricsByFile = new Map<string, GraphMetric[]>();
  for (const m of metrics) {
    if (!isCarriedMetric(m.name)) continue;
    pushBucket(sourceMetricsByFile, metricFileKey(m, nodesById), m);
  }
  return sourceMetricsByFile;
}

function indexStructuralHashes(
  fingerprints: readonly FileFingerprint[],
): Map<string, string> {
  const structuralHashes = new Map<string, string>();
  for (const f of fingerprints) {
    if (f.structuralHash) structuralHashes.set(f.fileId, f.structuralHash);
  }
  return structuralHashes;
}

function readReuseBasis(
  db: CodeGraphStore,
  snapshotId: number,
  fingerprints: readonly FileFingerprint[],
): ReuseBasis {
  // Opt into the symbol layer: reuse must carry symbol nodes and their inbound
  // reference edges forward for unchanged files (C-53).
  const { nodesById, symbolsByFile } = indexNodes(
    db.listNodes(snapshotId, { includeSymbols: true }),
  );
  const edgesBySrc = groupEdgesBySource(
    db.listEdges(snapshotId, { includeReferences: true }),
  );
  const sourceMetricsByFile = groupSourceMetrics(db.listMetrics(snapshotId), nodesById);
  return {
    snapshotId,
    fingerprints: new Map(fingerprints.map((f) => [f.fileId, f.contentHash])),
    structuralHashes: indexStructuralHashes(fingerprints),
    nodesById,
    edgesBySrc,
    sourceMetricsByFile,
    symbolsByFile,
  };
}

/**
 * Pick the most recent snapshot usable as a reuse basis: same index version and
 * carrying file fingerprints. Older snapshots predate the fingerprint table and
 * can't be diffed, so we return null and the caller does a full index.
 */
export function loadReuseBasis(
  db: CodeGraphStore,
  indexVersion: string,
): ReuseBasis | null {
  for (const snap of db.listSnapshots({ limit: 50 })) {
    if (snap.indexVersion !== indexVersion) continue;
    const fingerprints = db.listFingerprints(snap.id);
    if (fingerprints.length === 0) continue;
    return readReuseBasis(db, snap.id, fingerprints);
  }
  return null;
}
