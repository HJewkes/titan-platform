import { SourceRead, ReadSource, ReadModel, SnapshotInfo } from './query/index.js';
export { AGENT_COMMANDS, AttentionSignal, CHANGES_ROWS_MAX, CODE_READ_API_VERSION, COMMAND_NAMES, CONTRACT, Capabilities, CatalogueEntry, Centrality, ChurnWindow, CoChangePair, CodeReadCommandMap, CommandArgs, CommandContract, CommandInput, CommandName, CommandResult, CoupledPartners, CrossEdge, EXCERPT_LINE_CAP, EXCERPT_MISSING, ExcerptMissing, ExportRow, FINDINGS_PAGE_MAX, Finding, FindingChange, FindingDelta, FindingSort, FindingStatus, HIERARCHY_ROW_CAP, HOTSPOTS_PAGE_MAX, Hotspot, HotspotMark, ImpactRollup, LinkedTests, LookFirstRow, MISSING_REASONS, MetricDescriptor, MetricValue, Missing, MissingReason, ModelAlias, ModelEdge, ModelFinding, ModelMetric, ModelNode, ModelRule, NewFile, NodeKind, NodeLens, NodeLenses, NodeRef, OVERVIEW_ROWS_MAX, PACKAGES_MAX, PATHS_IMPACT_MAX, PackageLayer, PackageStatsRow, PathDelta, PathHotspot, PathImpact, Provenance, ProvenanceKind, QUERIES, QueryFn, QueryResolver, RELATED_CAP, ReadError, ReadModelParts, ReadingOrderRow, Regression, RuleSummary, SYNTHESIZED_KINDS, ScoreBreakdown, ScoreChange, SerializedContract, Severity, SnapshotRef, SourceExcerpt, SourceFacts, SourceOrigin, SourceWindow, Span, buildReadModel, createQueryResolver, declaredTiers, describeApi, excessOf, findingNotFound, getChanges, getFinding, getHierarchy, getNeighbors, getNode, getOverview, invalidArgs, isStoredKind, listFindings, listHotspots, listSnapshots, nodeNotFound, packagesStats, pathsImpact, repoRelative, resolveNode, resolveSnapshot, serializeContract, snapshotNotFound } from './query/index.js';
import { CodeGraphStore, CheckRule, SnapshotRow } from '@titan-design/code-graph';
import { BaseContext, AnyCommand, CommandRegistry } from '@titan-design/registry';
import 'zod';
import '@titan-design/code-graph/analysis';
import '@titan-design/rpc-protocol';

/** A least-recently-used cache; Map iteration order is insertion order, so the first key is the eldest. */
declare class LruCache<K, V> {
    readonly capacity: number;
    private readonly entries;
    constructor(capacity: number);
    get size(): number;
    has(key: K): boolean;
    /** The cached value, refreshed to most recent; otherwise `load`'s value, evicting the eldest when full. */
    getOrLoad(key: K, load: () => V): V;
    clear(): void;
    keys(): K[];
}

type FingerprintStore = Pick<CodeGraphStore, "listFingerprints">;
type SourceReader = (snapshotId: number, fileId: string) => SourceRead;
/**
 * Reads files from the working tree and serves them only when their hash matches the snapshot's fingerprint,
 * so line numbers never disagree with the snapshot the finding came from.
 */
declare function createWorktreeReader(store: FingerprintStore, repoRoot: string, cacheSize?: number): SourceReader;

/** The store reads the live source needs; structural, so any compatible code-graph release fits. */
type SnapshotStore = Pick<CodeGraphStore, "getSnapshot" | "listSnapshots" | "listNodes" | "listEdges" | "listMetrics" | "listAliases" | "listFingerprints">;
interface CodeReadDeps {
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
declare const DEFAULT_MODEL_CACHE_SIZE = 3;
declare function toSnapshotInfo(row: SnapshotRow): SnapshotInfo;
/** How a model derives its findings: the rules to run and, optionally, a reader that locates flagged lines. */
interface FindingOptions {
    rules: readonly CheckRule[];
    read?: SourceReader;
}
/** Read one whole snapshot, symbols and reference edges included, into a `ReadModel`, with findings when rules are given. */
declare function loadReadModel(store: SnapshotStore, snapshotId: number, findings?: FindingOptions): ReadModel;
interface LiveSource extends ReadSource {
    /** Snapshot ids currently cached, eldest first. */
    cachedSnapshots(): number[];
}
/** A `ReadSource` over a code-graph store; snapshots are immutable, so models are cached by id until the rules change. */
declare function createLiveSource(deps: CodeReadDeps): LiveSource;

/** A plain-language statement of what a check rule demands, for a finding's `why`. */
declare function describeRule(rule: CheckRule): string;

/**
 * One registry command per contract entry, answering from `source`. Exposed so a product can
 * register a subset on a second registry, for example an MCP-only one, until the registry filters surfaces.
 */
declare function defineCodeReadCommands<Ctx extends BaseContext = BaseContext>(source: ReadSource): AnyCommand<Ctx>[];
/** Register every read command on a product's registry over a live store; returns the source for inspection. */
declare function registerCodeReadCommands<Ctx extends BaseContext>(registry: CommandRegistry<Ctx>, deps: CodeReadDeps): LiveSource;

export { type CodeReadDeps, DEFAULT_MODEL_CACHE_SIZE, type FindingOptions, type FingerprintStore, type LiveSource, LruCache, ReadModel, ReadSource, SnapshotInfo, type SnapshotStore, SourceRead, type SourceReader, createLiveSource, createWorktreeReader, defineCodeReadCommands, describeRule, loadReadModel, registerCodeReadCommands, toSnapshotInfo };
