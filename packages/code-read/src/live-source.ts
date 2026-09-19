import { describeMetric, type CheckRule, type CodeGraphStore, type SnapshotRow } from "@titan-design/code-graph";
import { deriveFindings, toModelRules } from "./findings-live.js";
import { LruCache } from "./lru.js";
import { COMMAND_NAMES } from "./query/contract.js";
import { buildReadModel, type ModelNode, type ReadModel } from "./query/model.js";
import type { Capabilities, SnapshotInfo } from "./query/schemas.js";
import { snapshotNotFound, type ReadSource, type SourceFacts } from "./query/source.js";
import { createWorktreeReader, type SourceReader } from "./source-reader.js";

/** The store reads the live source needs; structural, so any compatible code-graph release fits. */
export type SnapshotStore = Pick<
  CodeGraphStore,
  "getSnapshot" | "listSnapshots" | "listNodes" | "listEdges" | "listMetrics" | "listAliases" | "listFingerprints"
>;

export interface CodeReadDeps {
  /** Called once, on first use; the source holds the store for its lifetime. */
  openStore: () => SnapshotStore;
  /**
   * The product's check rules: reported by `api.describe` and run on each snapshot to derive findings. Policy, so the
   * package has no default set. Return the same array while the rules are unchanged; a new array drops every cached model.
   */
  rules?: () => readonly CheckRule[];
  /** The git toplevel the snapshots were indexed from; excerpts are served only where the file still matches its snapshot. */
  repoRoot?: string | null;
  /** Snapshot models kept in memory; each holds a whole snapshot. Defaults to 3. */
  cacheSize?: number;
}

export const DEFAULT_MODEL_CACHE_SIZE = 3;

// Findings are derived from check rules; the stored findings, verdicts, themes, and feedback arrive with G11.
function liveCapabilities(hasSource: boolean): Capabilities {
  return {
    findings: "check-rules",
    verdicts: false,
    themes: false,
    feedback: false,
    embeddings: null,
    cochange: false,
    sourceAtCommit: false,
    excerpts: hasSource ? "any" : "none",
  };
}

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

/** How a model derives its findings: the rules to run and, optionally, a reader that locates flagged lines. */
export interface FindingOptions {
  rules: readonly CheckRule[];
  read?: SourceReader;
}

/** Read one whole snapshot, symbols and reference edges included, into a `ReadModel`, with findings when rules are given. */
export function loadReadModel(store: SnapshotStore, snapshotId: number, findings?: FindingOptions): ReadModel {
  const row = store.getSnapshot(snapshotId);
  if (!row) throw snapshotNotFound(snapshotId);
  const edges = store.listEdges(snapshotId, { includeReferences: true }).map((e) => ({ ...e, attrs: e.attrs ?? {} }));
  const rules = findings?.rules ?? [];
  return buildReadModel({
    snapshot: toSnapshotInfo(row),
    nodes: store.listNodes(snapshotId, { includeSymbols: true }).map(toModelNode),
    edges,
    aliases: store.listAliases(snapshotId),
    metrics: store.listMetrics(snapshotId),
    describe: describeMetric,
    findings: deriveFindings(store, rules, { snapshotId, edges, read: findings?.read }),
    rules: toModelRules(rules),
  });
}

export interface LiveSource extends ReadSource {
  /** Snapshot ids currently cached, eldest first. */
  cachedSnapshots(): number[];
}

/** A `ReadSource` over a code-graph store; snapshots are immutable, so models are cached by id alone. */
const NO_RULES: readonly CheckRule[] = [];

interface RuleTrackedModels {
  models: LruCache<number, ReadModel>;
  /** The product's current rules; a different array than last time empties the model cache. */
  rules(): readonly CheckRule[];
}

function ruleTrackedModels(deps: CodeReadDeps): RuleTrackedModels {
  const models = new LruCache<number, ReadModel>(deps.cacheSize ?? DEFAULT_MODEL_CACHE_SIZE);
  let seen = NO_RULES;
  const rules = (): readonly CheckRule[] => {
    const current = deps.rules?.() ?? NO_RULES;
    if (current !== seen) {
      models.clear();
      seen = current;
    }
    return current;
  };
  return { models, rules };
}

/** A `ReadSource` over a code-graph store; snapshots are immutable, so models are cached by id until the rules change. */
export function createLiveSource(deps: CodeReadDeps): LiveSource {
  let store: SnapshotStore | undefined;
  let reader: SourceReader | undefined;
  const openOnce = (): SnapshotStore => (store ??= deps.openStore());
  const root = deps.repoRoot ?? null;
  const read: SourceReader | undefined =
    root === null ? undefined : (id, file) => (reader ??= createWorktreeReader(openOnce(), root))(id, file);
  const { models, rules } = ruleTrackedModels(deps);
  const facts = (): SourceFacts => ({
    dataset: "live",
    commands: COMMAND_NAMES,
    capabilities: liveCapabilities(read !== undefined),
    rules: rules().map((r) => ({ id: r.id, type: r.type, severity: r.severity ?? "error" })),
  });
  return {
    facts,
    snapshots: () => openOnce().listSnapshots({ limit: ALL_SNAPSHOTS }).map(toSnapshotInfo),
    model: (snapshotId) => {
      const current = rules();
      return models.getOrLoad(snapshotId, () => loadReadModel(openOnce(), snapshotId, { rules: current, read }));
    },
    ...(read ? { readSource: read } : {}),
    cachedSnapshots: () => models.keys(),
  };
}
