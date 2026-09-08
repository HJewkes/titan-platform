import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import type { Node } from "web-tree-sitter";
import { getLanguageFromPath, type ParsedFile } from "./parser/index.js";
import type { CodeGraphStore } from "./store.js";
import { fileId } from "./extractors/ids.js";
import { SOURCE_METRIC_NAMES } from "./source-metrics.js";
import { reconstructCosmetic, reconstructFragment } from "./reconstruct.js";
import type { Extractor } from "./parser/index.js";
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
): Promise<ReadFile[]> {
  const out: ReadFile[] = [];
  for (const filePath of filePaths) {
    const language = sourceLanguage(filePath);
    if (language === null) continue;
    const content = await fs.readFile(filePath, "utf-8");
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

/** COSMETIC/structural split of the freshly-parsed files, plus every parsed and
 *  reused file's structural signature (to persist for the next run). */
export interface ParsedClassification {
  /** Parsed files whose structure matches the basis — reuse edges, skip extract. */
  cosmeticFileIds: Set<string>;
  /** fileId → structural signature, for every parsed file and every reused file. */
  structuralByFileId: Map<string, string>;
}

/**
 * Split freshly-parsed files into COSMETIC (structure unchanged vs the basis —
 * only comments/whitespace moved) and STRUCTURAL (a real token change), by
 * comparing each file's structural signature against the basis (C-18). Also
 * carries reused (NONE-tier) files' signatures forward so they survive across
 * generations rather than decaying to NULL after their first reuse.
 */
export function classifyParsed(
  parsedByPath: Map<string, ParsedFile>,
  idRoot: string,
  reuse: ReuseBasis | null,
  reusedFileIds: readonly string[],
  affected: ReadonlySet<string> = new Set(),
): ParsedClassification {
  const cosmeticFileIds = new Set<string>();
  const structuralByFileId = new Map<string, string>();
  for (const [filePath, parsed] of parsedByPath) {
    const id = fileId(idRoot, filePath);
    const sig = structuralSignature(parsed);
    structuralByFileId.set(id, sig);
    // A file affected by a membership delta (C-20) has a stale basis edge set even
    // though its structure is unchanged, so it must NOT take the cosmetic path.
    if (reuse && !affected.has(id) && reuse.structuralHashes.get(id) === sig) {
      cosmeticFileIds.add(id);
    }
  }
  if (reuse) {
    for (const id of reusedFileIds) {
      const sig = reuse.structuralHashes.get(id);
      if (sig !== undefined) structuralByFileId.set(id, sig);
    }
  }
  return { cosmeticFileIds, structuralByFileId };
}

/**
 * Build fragments for all files in walk order — extracting STRUCTURAL freshly-
 * parsed files, reconstructing NONE-tier reused ones, and (C-18) reconstructing
 * COSMETIC files from the basis edges while refreshing their symbol line spans
 * from the fresh parse, skipping the expensive ts-morph extract. Walk order is
 * preserved so the merge dedup resolves shared nodes identically to a full index.
 */
export function assembleFragments(input: {
  readFiles: readonly ReadFile[];
  idRoot: string;
  parsedByPath: Map<string, ParsedFile>;
  reuse: ReuseBasis | null;
  cosmeticFileIds: ReadonlySet<string>;
  extractor: Extractor<GraphFragment>;
}): GraphFragment[] {
  const fragments: GraphFragment[] = [];
  for (const rf of input.readFiles) {
    const parsed = input.parsedByPath.get(rf.filePath);
    const id = fileId(input.idRoot, rf.filePath);
    if (parsed && input.reuse && input.cosmeticFileIds.has(id)) {
      fragments.push(
        reconstructCosmetic(input.idRoot, rf.filePath, id, input.reuse, parsed),
      );
    } else if (parsed) {
      fragments.push(...input.extractor.extract(parsed));
    } else if (input.reuse) {
      fragments.push(
        reconstructFragment(input.idRoot, rf.filePath, id, input.reuse),
      );
    }
  }
  return fragments;
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
 * source, and the source-content metrics (loc, complexity, lcom4, ...).
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

    const nodesById = new Map<string, GraphNode>();
    const symbolsByFile = new Map<string, GraphNode[]>();
    // Opt into the symbol layer: reuse must carry symbol nodes and their inbound
    // reference edges forward for unchanged files (C-53).
    for (const n of db.listNodes(snap.id, { includeSymbols: true })) {
      nodesById.set(n.id, n);
      if (n.kind === "symbol" && n.parentId) {
        const bucket = symbolsByFile.get(n.parentId);
        if (bucket) bucket.push(n);
        else symbolsByFile.set(n.parentId, [n]);
      }
    }

    const edgesBySrc = new Map<string, GraphEdge[]>();
    for (const e of db.listEdges(snap.id, { includeReferences: true })) {
      const bucket = edgesBySrc.get(e.srcId);
      if (bucket) bucket.push(e);
      else edgesBySrc.set(e.srcId, [e]);
    }

    const sourceMetricsByFile = new Map<string, GraphMetric[]>();
    for (const m of db.listMetrics(snap.id)) {
      // Source-content metrics are pure functions of a file's bytes, so they
      // carry forward verbatim for an unchanged file.
      if (!SOURCE_METRIC_NAMES.has(m.name)) continue;
      // Per-symbol metrics (C-58) live on `<fileId>#<name>` nodes; bucket them
      // under their parent file so an unchanged file carries its symbol
      // complexity forward alongside its file-level source metrics.
      const node = nodesById.get(m.nodeId);
      const fileKey =
        node?.kind === "symbol" && node.parentId ? node.parentId : m.nodeId;
      const bucket = sourceMetricsByFile.get(fileKey);
      if (bucket) bucket.push(m);
      else sourceMetricsByFile.set(fileKey, [m]);
    }

    const structuralHashes = new Map<string, string>();
    for (const f of fingerprints) {
      if (f.structuralHash) structuralHashes.set(f.fileId, f.structuralHash);
    }

    return {
      snapshotId: snap.id,
      fingerprints: new Map(fingerprints.map((f) => [f.fileId, f.contentHash])),
      structuralHashes,
      nodesById,
      edgesBySrc,
      sourceMetricsByFile,
      symbolsByFile,
    };
  }
  return null;
}
