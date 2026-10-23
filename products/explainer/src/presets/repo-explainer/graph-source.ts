import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { indexPaths, openCodeGraph, type CodeGraphStore } from "@titan-design/code-graph";
import { diag, type GatherDiagnostic } from "./diagnostics.js";
import { reviewScopeFiles, scopedSource, scopeRoots } from "./review-scope.js";
import type { StructureSource } from "./structure-schema.js";

/** Where a finished review keeps its code-graph index, relative to the review dir. */
export const REVIEW_GRAPH_DB = "structural/graph.db";

export type IndexFn = typeof indexPaths;

export interface GraphSourceOptions {
  reviewDir: string;
  clonePath: string;
  /** The review pin; a snapshot is used only when it was taken at this commit. */
  pin: string;
  /** Keeps the working db between runs; defaults to a temp dir removed on close. */
  cacheDir?: string;
  /** Injected so tests can fail or spy on the index. */
  index?: IndexFn;
}

export interface StructureGraph {
  store: CodeGraphStore;
  snapshotId: number;
  source: StructureSource;
  files: number;
  close(): Promise<void>;
}

export type GraphSourceResult =
  | { ok: true; graph: StructureGraph; diagnostics: GatherDiagnostic[] }
  | { ok: false; diagnostics: GatherDiagnostic[] };

const ALL_SNAPSHOTS = 1_000_000;

function snapshotAt(store: CodeGraphStore, pin: string): number | undefined {
  return store.listSnapshots({ limit: ALL_SNAPSHOTS }).find((row) => row.commitHash === pin)?.id;
}

function fileCount(store: CodeGraphStore, snapshotId: number): number {
  return store.listNodes(snapshotId).filter((node) => node.kind === "file").length;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function workDir(cacheDir: string | undefined): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  if (cacheDir !== undefined) {
    await mkdir(cacheDir, { recursive: true });
    return { dir: cacheDir, cleanup: async () => {} };
  }
  const dir = await mkdtemp(join(tmpdir(), "rx-structure-"));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

interface ReviewIndex {
  /** Set when the review db holds a snapshot at the pin. */
  snapshot?: { store: CodeGraphStore; snapshotId: number };
  /** The files the review read, for a fresh index to stay inside. */
  scope: string[];
}

// A review db is copied before it is opened, because opening runs migrations and the review stays read-only.
// Its write-ahead log goes with it: rows committed but not yet checkpointed live only there.
async function reviewIndex(options: GraphSourceOptions, dir: string, out: GatherDiagnostic[]): Promise<ReviewIndex> {
  const reviewDb = join(options.reviewDir, REVIEW_GRAPH_DB);
  if (!existsSync(reviewDb)) return { scope: [] };
  const copy = join(dir, "review-graph.db");
  await copyFile(reviewDb, copy);
  if (existsSync(`${reviewDb}-wal`)) await copyFile(`${reviewDb}-wal`, `${copy}-wal`);
  const store = openCodeGraph(copy);
  const snapshotId = snapshotAt(store, options.pin);
  if (snapshotId !== undefined) return { snapshot: { store, snapshotId }, scope: [] };
  const scope = reviewScopeFiles(store);
  store.close();
  out.push(diag("W-INDEX-PIN", `${REVIEW_GRAPH_DB} has no snapshot at ${options.pin}; indexing the clone fresh`, REVIEW_GRAPH_DB));
  return { scope };
}

function indexScope(options: GraphSourceOptions, scope: readonly string[], out: GatherDiagnostic[]) {
  if (scope.length === 0) {
    out.push(diag("W-INDEX-SCOPE", "the review holds no file list to scope the index; indexing the whole clone", options.clonePath));
    return { paths: [options.clonePath] };
  }
  return { paths: scopeRoots(options.clonePath, scope), source: scopedSource(options.clonePath, scope) };
}

async function freshSnapshot(options: GraphSourceOptions, dir: string, scope: readonly string[], out: GatherDiagnostic[]) {
  const store = openCodeGraph(join(dir, "graph.db"));
  const cached = snapshotAt(store, options.pin);
  if (cached !== undefined) return { store, snapshotId: cached };
  const index = options.index ?? indexPaths;
  try {
    const result = await index(store, { ...indexScope(options, scope, out), commitHash: options.pin, computeMetrics: true, computeChurn: false });
    return { store, snapshotId: result.snapshotId };
  } catch (error) {
    store.close();
    throw error;
  }
}

/**
 * Opens the code graph the structure stage reads: the review's own index when it holds a snapshot at
 * the pin, else a fresh index of the clone. A failure to open or build it is `E-INDEX`; an index with
 * no files is `W-NO-INDEX`, which still returns the graph so facts read as unindexed.
 */
export async function openStructureGraph(options: GraphSourceOptions): Promise<GraphSourceResult> {
  const diagnostics: GatherDiagnostic[] = [];
  const { dir, cleanup } = await workDir(options.cacheDir);
  try {
    const review = await reviewIndex(options, dir, diagnostics);
    const opened = review.snapshot ?? (await freshSnapshot(options, dir, review.scope, diagnostics));
    const files = fileCount(opened.store, opened.snapshotId);
    if (files === 0) diagnostics.push(diag("W-NO-INDEX", `the index at ${options.pin} holds no source files`, options.clonePath));
    const close = async () => {
      opened.store.close();
      await cleanup();
    };
    const source: StructureSource = review.snapshot === undefined ? "fresh-index" : "review-index";
    return { ok: true, graph: { ...opened, source, files, close }, diagnostics };
  } catch (error) {
    await cleanup();
    diagnostics.push(diag("E-INDEX", `cannot open or build the code graph: ${message(error)}`, options.clonePath));
    return { ok: false, diagnostics };
  }
}
