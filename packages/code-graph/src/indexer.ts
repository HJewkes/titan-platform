import { realpathSync } from "node:fs";
import * as path from "node:path";
import type { CodeGraphStore } from "./store.js";
import { LanguageExtractor } from "./extractors/dispatch.js";
import { detectGitHead, detectGitToplevel } from "./git-renames.js";
import { computeAliasBridge } from "./identity/index-aliases.js";
import { ALIAS_BASE_ATTR } from "./identity/lineage.js";
import { annotateRoles, computeRoleHints } from "./roles.js";
import { workingTreeSource, type IndexSource } from "./index-source.js";
import { rootsAtRevision } from "./git-tree-source.js";
import { pruneDanglingReferences } from "./barrel-resolve.js";
import { fileId } from "./extractors/ids.js";
import { buildFingerprints, classifyForReuse, loadReuseBasis, readSourceFiles, streamFiles, type ReadFile, type StreamedFiles, type StreamFilesInput } from "./incremental.js";
import { computeContentAffected, computeDeltaAffected, surfaceChangedIds } from "./reuse-delta.js";
import { spliceStream } from "./stream-splice.js";
import { assembleIndexerMetrics } from "./index-metrics.js";
import { loadEntryPoints } from "./analysis/test-kinds.js";
import type { HistoryMetricsOptions } from "./history-metrics.js";
import { mergeFragments, type ExtractAccumulator } from "./merge.js";
import { predatesQualifiedSymbols, qualifiedSymbolAliases } from "./symbol-aliases.js";
import type { GraphMetric, IdAlias } from "./types.js";

/**
 * Bumping this invalidates every reuse basis: a snapshot written by a different
 * index version is never reused, so a change to node/edge shape or to a metric's
 * value for the same bytes can never be carried forward from an incompatible graph.
 */
export const INDEX_VERSION = "0.32.0";

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
  /** Git churn, recency, and ownership metrics. Defaults to `true`; history is skipped silently outside git. */
  computeChurn?: boolean;
  /** Primary churn window in days (default 30); scopes ownership. */
  churnWindowDays?: number;
  /** Windows to store churn for (default 30, 90, 180); the primary window is always included. */
  churnWindows?: number[];
  /** Also store an all-time `lifetime` churn and ownership window over full git history. */
  lifetime?: boolean;
  /** Where files are listed and read from. Defaults to {@link workingTreeSource}. */
  source?: IndexSource;
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
  /** Present only when git history was partial or missing (churn log overflowed or git failed); absent otherwise. */
  warnings?: string[];
}

function canonicalizePath(p: string): string {
  try {
    return realpathSync(p);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return p;
    throw err;
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
  snapshot: { ref: string; commitHash?: string; aliasBase: number | null },
  accumulator: ExtractAccumulator,
  aliases: readonly IdAlias[],
  metrics: readonly GraphMetric[],
): number {
  const { ref, commitHash, aliasBase } = snapshot;
  const attrs = { [ALIAS_BASE_ATTR]: aliasBase };
  const snapshotId = store.createSnapshot({ ref, commitHash, indexVersion: INDEX_VERSION, attrs });
  store.insertNodes(snapshotId, [...accumulator.nodes.values()]);
  store.insertEdges(snapshotId, [...accumulator.edges.values()]);
  if (aliases.length > 0) store.insertAliases(snapshotId, aliases);
  if (metrics.length > 0) store.insertMetrics(snapshotId, metrics);
  return snapshotId;
}

/** True when the newest prior snapshot wrote bare-name symbol ids, so this run must alias them to qualified ones. */
function needsRequalifyAliases(store: CodeGraphStore): boolean {
  const prior = store.listSnapshots({ limit: 1 })[0];
  return prior !== undefined && predatesQualifiedSymbols(prior.indexVersion);
}

/**
 * Node ids are rooted at the git toplevel so a subtree index shares an id space
 * with a whole-repo one. Inside git, roots are canonicalized to match
 * `git rev-parse --show-toplevel`, which resolves symlinks (`/var` →
 * `/private/var` on macOS); outside git they are left as the caller wrote them.
 * A revision source roots ids at its own repo root instead.
 */
function resolveRoots(paths: readonly string[], source: IndexSource): { rootDirs: string[]; idRoot: string } {
  const raw = normalizePaths(paths);
  if (source.revision) return rootsAtRevision(raw, source.revision);
  const gitToplevel = detectGitToplevel(raw[0]!);
  const rootDirs = gitToplevel !== null ? raw.map(canonicalizePath) : raw;
  return { rootDirs, idRoot: gitToplevel ?? rootDirs[0]! };
}

/** A revision's history ends at its commit, so its windows end at the commit's time, not the wall clock. */
function historyOptions(options: IndexOptions, source: IndexSource): HistoryMetricsOptions {
  return {
    churnWindowDays: options.churnWindowDays,
    churnWindows: options.churnWindows,
    includeLifetime: options.lifetime === true,
    rev: source.revision?.commit,
    nowEpoch: source.revision?.commitEpoch,
  };
}

type StreamInput = Omit<StreamFilesInput, "toParse" | "reusedFileIds" | "affected">;

interface ReuseStream {
  streamed: StreamedFiles;
  toParse: ReadFile[];
  reusedFileIds: string[];
}

/**
 * Streams every file, reusing what the basis allows. A byte-identical file still
 * re-extracts when a file-membership delta re-resolves its imports, or when it
 * has an edge to a file whose export surface the parsed files changed (TP-3636).
 * The surface is known only after the parse, so those files re-extract in a
 * second, small stream spliced into the first.
 */
async function streamWithReuse(input: StreamInput): Promise<ReuseStream> {
  const { reuse, readFiles, idRoot } = input;
  const idOf = (rf: ReadFile): string => fileId(idRoot, rf.filePath);
  const currentFileIds = new Set(readFiles.map(idOf));
  const delta = reuse ? computeDeltaAffected(reuse, currentFileIds) : new Set<string>();
  const { toParse, reusedFileIds } = classifyForReuse(readFiles, idRoot, reuse, delta);
  const streamed = await streamFiles({ ...input, toParse, reusedFileIds, affected: delta });
  if (!reuse) return { streamed, toParse, reusedFileIds };
  const parsedIds = new Set(toParse.map(idOf));
  const textChanged = new Set(toParse.filter((rf) => reuse.fingerprints.get(idOf(rf)) !== rf.hash).map(idOf));
  const surface = surfaceChangedIds(reuse, streamed.fragments, textChanged, parsedIds, currentFileIds);
  const content = new Set([...computeContentAffected(reuse, surface)].filter((id) => !parsedIds.has(id)));
  if (content.size === 0) return { streamed, toParse, reusedFileIds };
  const files = readFiles.filter((rf) => content.has(idOf(rf)));
  const second = await streamFiles({ ...input, readFiles: files, toParse: files, reusedFileIds: [], affected: content });
  return {
    streamed: spliceStream(streamed, second, readFiles.map(idOf)),
    toParse: [...toParse, ...files],
    reusedFileIds: reusedFileIds.filter((id) => !content.has(id)),
  };
}

/**
 * Index one or more roots into a new snapshot: walk, read, parse what changed,
 * extract, annotate roles, compute metrics, and persist. Files unchanged since
 * the prior snapshot are carried forward rather than re-parsed, so the result
 * matches a full index regardless of how much was reused.
 */
export async function indexPaths(store: CodeGraphStore, options: IndexOptions): Promise<IndexResult> {
  const source = options.source ?? workingTreeSource();
  const { rootDirs, idRoot } = resolveRoots(options.paths, source);
  const readFiles = await readSourceFiles(await source.listFiles(rootDirs, LANGUAGES), source);

  const reuse = options.incremental !== false ? loadReuseBasis(store, INDEX_VERSION) : null;
  const requalify = needsRequalifyAliases(store);
  const { streamed, toParse, reusedFileIds } = await streamWithReuse({
    readFiles,
    idRoot,
    reuse,
    extractor: new LanguageExtractor({ repoRoot: idRoot, tsConfigPath: options.tsConfig, source }),
    digest: requalify || options.computeMetrics !== false,
  });
  const accumulator = mergeFragments(streamed.fragments);
  const roleHints = computeRoleHints(readFiles, idRoot, fileId, source);
  const annotated = annotateRoles([...accumulator.nodes.values()], roleHints);
  accumulator.nodes = new Map(annotated.map((n) => [n.id, n]));
  pruneDanglingReferences(accumulator.nodes, accumulator.edges);

  const { metrics, warnings } =
    options.computeMetrics === false
      ? { metrics: [], warnings: [] }
      : assembleIndexerMetrics({
          nodes: accumulator.nodes,
          edges: accumulator.edges,
          fileDigests: streamed.digests,
          reusedSourceMetrics: reuse
            ? reusedFileIds.flatMap((id) => reuse.sourceMetricsByFile.get(id) ?? [])
            : [],
          idRoot,
          history: options.computeChurn === false ? undefined : historyOptions(options, source),
          entryPoints: loadEntryPoints([idRoot, ...rootDirs], source),
        });

  // A revision's indexed dirs may be gone from disk, so its git calls run at the repo root.
  const rootDir = source.revision ? idRoot : rootDirs[0]!;
  const ref = options.ref ?? "wd";
  const commitHash = options.commitHash ?? source.revision?.commit ?? detectGitHead(rootDir) ?? undefined;
  const bridge = computeAliasBridge(store, { ...options, rootDir, idRoot, ref, commitHash, nodes: accumulator.nodes });
  const aliases = [
    ...bridge.aliases,
    ...(requalify ? qualifiedSymbolAliases(streamed.digests, new Set(accumulator.nodes.keys())) : []),
  ];
  const snapshot = { ref, commitHash, aliasBase: bridge.baseSnapshotId };
  const fingerprints = buildFingerprints(readFiles, idRoot, streamed.structuralByFileId);
  const snapshotId = store.atomically(() => {
    const id = persist(store, snapshot, accumulator, aliases, metrics);
    store.insertFingerprints(id, fingerprints);
    return id;
  });

  return {
    snapshotId,
    files: readFiles.length,
    nodes: accumulator.nodes.size,
    edges: accumulator.edges.size,
    aliases: aliases.length,
    metrics: metrics.length,
    reused: reusedFileIds.length,
    reparsed: toParse.length,
    cosmetic: streamed.cosmeticFileIds.size,
    nodesByKind: countByKind(accumulator.nodes.values()),
    edgesByKind: countByKind(accumulator.edges.values()),
    ...(warnings.length > 0 ? { warnings: [...warnings] } : {}),
  };
}
