import { describeMetric, type CheckRule, type CodeGraphStore, type SnapshotRow } from "@titan-design/code-graph";
import { LruCache } from "./lru.js";
import { COMMAND_NAMES } from "./query/contract.js";
import { buildReadModel, type ModelNode, type ReadModel } from "./query/model.js";
import type { Capabilities, SnapshotInfo } from "./query/schemas.js";
import { snapshotNotFound, type ReadSource, type SourceFacts } from "./query/source.js";

/** The store reads the live source needs; structural, so any compatible code-graph release fits. */
export type SnapshotStore = Pick<
  CodeGraphStore,
  "getSnapshot" | "listSnapshots" | "listNodes" | "listEdges" | "listMetrics" | "listAliases"
>;

export interface CodeReadDeps {
  /** Called once, on first use; the source holds the store for its lifetime. */
  openStore: () => SnapshotStore;
  /** The product's check rules, reported by `api.describe`. Policy, so the package has no default set. */
  rules?: () => readonly CheckRule[];
  /** Snapshot models kept in memory; each holds a whole snapshot. Defaults to 3. */
  cacheSize?: number;
}

export const DEFAULT_MODEL_CACHE_SIZE = 3;

// Shipped commands only: findings, source reads, and embeddings arrive with later commands.
const LIVE_CAPABILITIES: Capabilities = {
  findings: "none",
  verdicts: false,
  themes: false,
  feedback: false,
  embeddings: null,
  cochange: false,
  sourceAtCommit: false,
  excerpts: "none",
};

// Far above any real snapshot count; the store's own default of 50 would hide older snapshots.
const ALL_SNAPSHOTS = 1_000_000;

export function toSnapshotInfo(row: SnapshotRow): SnapshotInfo {
  return { id: row.id, ref: row.ref, commit: row.commitHash, takenAt: row.takenAt, indexVersion: row.indexVersion };
}

function toModelNode(node: ReturnType<SnapshotStore["listNodes"]>[number]): ModelNode {
  const out: ModelNode = { id: node.id, kind: node.kind, name: node.name, parentId: node.parentId ?? null, attrs: node.attrs ?? {} };
  if (node.language !== undefined) out.language = node.language;
  if (node.role !== undefined) out.role = node.role;
  return out;
}

/** Read one whole snapshot, symbols and reference edges included, into a `ReadModel`. */
export function loadReadModel(store: SnapshotStore, snapshotId: number): ReadModel {
  const row = store.getSnapshot(snapshotId);
  if (!row) throw snapshotNotFound(snapshotId);
  return buildReadModel({
    snapshot: toSnapshotInfo(row),
    nodes: store.listNodes(snapshotId, { includeSymbols: true }).map(toModelNode),
    edges: store.listEdges(snapshotId, { includeReferences: true }).map((e) => ({ ...e, attrs: e.attrs ?? {} })),
    aliases: store.listAliases(snapshotId),
    metrics: store.listMetrics(snapshotId),
    describe: describeMetric,
  });
}

export interface LiveSource extends ReadSource {
  /** Snapshot ids currently cached, eldest first. */
  cachedSnapshots(): number[];
}

/** A `ReadSource` over a code-graph store; snapshots are immutable, so models are cached by id alone. */
export function createLiveSource(deps: CodeReadDeps): LiveSource {
  let store: SnapshotStore | undefined;
  const openOnce = (): SnapshotStore => (store ??= deps.openStore());
  const models = new LruCache<number, ReadModel>(deps.cacheSize ?? DEFAULT_MODEL_CACHE_SIZE);
  const facts = (): SourceFacts => ({
    dataset: "live",
    commands: COMMAND_NAMES,
    capabilities: LIVE_CAPABILITIES,
    rules: (deps.rules?.() ?? []).map((r) => ({ id: r.id, type: r.type, severity: r.severity ?? "error" })),
  });
  return {
    facts,
    snapshots: () => openOnce().listSnapshots({ limit: ALL_SNAPSHOTS }).map(toSnapshotInfo),
    model: (snapshotId) => models.getOrLoad(snapshotId, () => loadReadModel(openOnce(), snapshotId)),
    cachedSnapshots: () => models.keys(),
  };
}
