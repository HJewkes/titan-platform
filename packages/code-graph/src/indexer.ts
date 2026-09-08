import { realpathSync } from "node:fs";
import * as path from "node:path";
import { parseFile, type ParsedFile } from "./parser/index.js";
import type { CodeGraphStore } from "./store.js";
import { LanguageExtractor } from "./extractors/dispatch.js";
import {
  buildAliases,
  detectGitHead,
  detectGitToplevel,
  detectRenames,
  isInsideGitRepo,
} from "./git-renames.js";
import { annotateRoles, computeRoleHints } from "./roles.js";
import { walkSourceFiles } from "./file-walk.js";
import { pruneDanglingReferences } from "./barrel-resolve.js";
import { fileId } from "./extractors/ids.js";
import {
  assembleFragments,
  buildFingerprints,
  classifyForReuse,
  classifyParsed,
  loadReuseBasis,
  readSourceFiles,
} from "./incremental.js";
import { computeDeltaAffected } from "./reuse-delta.js";
import { buildIndexerMetrics } from "./index-metrics.js";
import { mergeFragments, type ExtractAccumulator } from "./merge.js";
import type { GraphMetric, IdAlias } from "./types.js";

/**
 * Bumping this invalidates every reuse basis: a snapshot written by a different
 * index version is never reused, so a change to node/edge shape can never be
 * carried forward from an incompatible graph.
 */
export const INDEX_VERSION = "0.11.0";

/** The languages walked and extracted. `typescript` covers `.ts` and `.tsx`. */
const LANGUAGES = ["typescript", "python"] as const;

export interface IndexOptions {
  /** Roots to walk. Node ids are still rooted at the git toplevel, so importers across roots share an id space. */
  paths: string[];
  ref?: string;
  commitHash?: string;
  tsConfig?: string;
  detectRenames?: boolean;
  computeMetrics?: boolean;
  /**
   * Reuse the prior snapshot for byte-identical files: skip their tree-sitter
   * parse + ts-morph extract and carry their nodes/edges/source metrics forward.
   * Defaults to `true`; the reuse path is equivalent to a full index, so the only
   * reason to disable it is to rebuild from scratch.
   */
  incremental?: boolean;
}

export interface IndexResult {
  snapshotId: number;
  files: number;
  nodes: number;
  edges: number;
  aliases: number;
  metrics: number;
  /** Files whose parse + extract were skipped by reusing the prior snapshot. */
  reused: number;
  /** Files parsed + extracted this run (new, changed, or full index). */
  reparsed: number;
  /** Parsed files whose extract was skipped as cosmetic; a subset of `reparsed`. */
  cosmetic: number;
  nodesByKind: Record<string, number>;
  edgesByKind: Record<string, number>;
}

function canonicalizePath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function normalizePaths(paths: readonly string[]): string[] {
  if (paths.length === 0) throw new Error("indexPaths requires at least one path");
  return [...new Set(paths.map((p) => path.resolve(p)))];
}

function countByKind<T extends { kind: string }>(items: Iterable<T>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) out[item.kind] = (out[item.kind] ?? 0) + 1;
  return out;
}

function persist(
  store: CodeGraphStore,
  ref: string,
  commitHash: string | undefined,
  accumulator: ExtractAccumulator,
  aliases: readonly IdAlias[],
  metrics: readonly GraphMetric[],
): number {
  const snapshotId = store.createSnapshot({ ref, commitHash, indexVersion: INDEX_VERSION });
  store.insertNodes(snapshotId, [...accumulator.nodes.values()]);
  store.insertEdges(snapshotId, [...accumulator.edges.values()]);
  if (aliases.length > 0) store.insertAliases(snapshotId, aliases);
  if (metrics.length > 0) store.insertMetrics(snapshotId, metrics);
  return snapshotId;
}

function findPriorCommit(store: CodeGraphStore): string | null {
  return store.listSnapshots({ limit: 50 }).find((s) => s.commitHash)?.commitHash ?? null;
}

/** Id aliases bridging a rename between the prior snapshot's commit and this one. */
function resolveAliases(
  rootDir: string,
  idRoot: string,
  options: IndexOptions,
  store: CodeGraphStore,
): IdAlias[] {
  if (options.detectRenames === false) return [];
  if (!isInsideGitRepo(rootDir)) return [];
  const priorCommit = findPriorCommit(store);
  if (!priorCommit) return [];
  const target = options.commitHash ?? detectGitHead(rootDir) ?? undefined;
  if (target === priorCommit) return [];
  return buildAliases(idRoot, detectRenames({ repoRoot: rootDir, fromCommit: priorCommit, toCommit: target }));
}

/**
 * Node ids are rooted at the git toplevel so a subtree index shares an id space
 * with a whole-repo one. Inside git, roots are canonicalized to match
 * `git rev-parse --show-toplevel`, which resolves symlinks (`/var` →
 * `/private/var` on macOS); outside git they are left as the caller wrote them.
 */
function resolveRoots(paths: readonly string[]): { rootDirs: string[]; idRoot: string } {
  const raw = normalizePaths(paths);
  const gitToplevel = detectGitToplevel(raw[0]!);
  const rootDirs = gitToplevel !== null ? raw.map(canonicalizePath) : raw;
  return { rootDirs, idRoot: gitToplevel ?? rootDirs[0]! };
}

async function parseAll(
  toParse: readonly { filePath: string; content: string; language: string }[],
): Promise<Map<string, ParsedFile>> {
  const parsed = new Map<string, ParsedFile>();
  for (const rf of toParse) {
    parsed.set(rf.filePath, await parseFile(rf.content, rf.filePath, rf.language));
  }
  return parsed;
}

/**
 * Index one or more roots into a new snapshot: walk, read, parse what changed,
 * extract, annotate roles, compute metrics, and persist. Files unchanged since
 * the prior snapshot are carried forward rather than re-parsed, so the result
 * matches a full index regardless of how much was reused.
 */
export async function indexPaths(store: CodeGraphStore, options: IndexOptions): Promise<IndexResult> {
  const { rootDirs, idRoot } = resolveRoots(options.paths);
  const readFiles = await readSourceFiles(await walkSourceFiles(rootDirs, LANGUAGES));

  const reuse = options.incremental !== false ? loadReuseBasis(store, INDEX_VERSION) : null;
  const currentFileIds = new Set(readFiles.map((rf) => fileId(idRoot, rf.filePath)));
  // On a file-membership delta, reuse every unchanged file except those whose
  // imports the delta re-resolves; empty when membership is unchanged.
  const affected = reuse ? computeDeltaAffected(reuse, currentFileIds) : new Set<string>();
  const { toParse, reusedFileIds } = classifyForReuse(readFiles, idRoot, reuse, affected);

  const parsedByPath = await parseAll(toParse);
  const classified = classifyParsed(parsedByPath, idRoot, reuse, reusedFileIds, affected);
  const accumulator = mergeFragments(
    assembleFragments({
      readFiles,
      idRoot,
      parsedByPath,
      reuse,
      cosmeticFileIds: classified.cosmeticFileIds,
      extractor: new LanguageExtractor({ repoRoot: idRoot, tsConfigPath: options.tsConfig }),
    }),
  );
  const annotated = annotateRoles([...accumulator.nodes.values()], computeRoleHints(readFiles, idRoot, fileId));
  accumulator.nodes = new Map(annotated.map((n) => [n.id, n]));
  pruneDanglingReferences(accumulator.nodes, accumulator.edges);

  const metrics =
    options.computeMetrics === false
      ? []
      : buildIndexerMetrics({
          nodes: accumulator.nodes,
          edges: accumulator.edges,
          parsedFiles: [...parsedByPath.values()],
          reusedSourceMetrics: reuse
            ? reusedFileIds.flatMap((id) => reuse.sourceMetricsByFile.get(id) ?? [])
            : [],
          idRoot,
        });

  const rootDir = rootDirs[0]!;
  const aliases = resolveAliases(rootDir, idRoot, options, store);
  const commitHash = options.commitHash ?? detectGitHead(rootDir) ?? undefined;
  const snapshotId = persist(store, options.ref ?? "wd", commitHash, accumulator, aliases, metrics);
  store.insertFingerprints(snapshotId, buildFingerprints(readFiles, idRoot, classified.structuralByFileId));

  return {
    snapshotId,
    files: readFiles.length,
    nodes: accumulator.nodes.size,
    edges: accumulator.edges.size,
    aliases: aliases.length,
    metrics: metrics.length,
    reused: reusedFileIds.length,
    reparsed: toParse.length,
    cosmetic: classified.cosmeticFileIds.size,
    nodesByKind: countByKind(accumulator.nodes.values()),
    edgesByKind: countByKind(accumulator.edges.values()),
  };
}
