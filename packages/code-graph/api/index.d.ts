import { N as NodeKind, G as GraphNode, a as GraphEdge, b as GraphMetric, I as IdAlias, F as FileFingerprint, S as SnapshotRow, c as GraphFragment, d as NodeRole, e as IdAliasReason, T as TestSourceLink, f as Severity, C as CheckResult, E as EdgeKind, g as NodeMetrics, B as BlastRadiusEntry, R as ReferenceEdgeLite, h as SymbolConsumers, i as SymbolCouplingOptions, j as SymbolCouplingPair, k as CheckRule, l as CheckViolation, V as ViolationBuckets } from './browser.js';
export { A as ArchEdge, m as ArchPackage, n as ArchResult, o as ArchSubNode, p as BucketableViolation, q as BusFactorChange, r as BusFactorRow, s as CallGraphMetrics, t as CallableComplexity, u as CentralRow, v as CheckRulesFile, w as ComplexityDistribution, x as ComplexityRollup, y as ComputeArchInput, z as ComputeDriftInput, D as CouplingClass, H as CouplingDelta, J as CouplingRow, K as CycleKind, L as DEFAULT_HEALTH_WEIGHTS, M as DEFAULT_MAX_PACKAGE_SIZE, O as DeadModuleConsumer, P as DeadModuleRow, Q as DeadModuleView, U as DeadModulesOptions, W as EXTERNAL_BUCKET, X as EXTREME_CC, Y as ExcessChange, Z as ForbidImportRule, _ as GraphReportResult, $ as GrowthRiskRow, a0 as HIGH_CC, a1 as HealthComponent, a2 as HealthComponentKey, a3 as HealthInput, a4 as HealthWeights, a5 as HotExport, a6 as HotspotDelta, a7 as HotspotRow, a8 as ImportCyclicMass, a9 as LayeredDepsRule, aa as LinkMethod, ab as LinkTestsOptions, ac as MetricMaxRule, ad as MetricMinRule, ae as MetricOutlierRule, af as MetricProductMaxRule, ag as NODE_KINDS, ah as NODE_ROLES, ai as NewHotspot, aj as NoImportCyclesRule, ak as NoInternalOnlyBarrelsRule, al as PackageComplexityRow, am as PackageDependencyRow, an as PackageFlag, ao as PackageLayer, ap as PackageRoot, aq as PackageStats, ar as PairCoupling, as as PairFlag, at as PartitionQualityInput, au as PartitionQualityResult, av as PenaltyWeight, aw as QualitySection, ax as ReportContext, ay as ReportContextInput, az as ReportDrift, aA as SnapshotContext, aB as SymbolConsumerGroup, aC as SymbolConsumerRow, aD as SymbolCouplingPayload, aE as SymbolCouplingRow, aF as SymbolUtil, aG as TestCoverageRow, aH as UnchangedViolation, aI as UntestedRiskRow, aJ as UnusedExportRow, aK as ViolationIdentity, aL as WeightedLink, aM as aggregateEdges, aN as bucketFilesByPackage, aO as bucketViolations, aP as buildBlastRadius, aQ as buildCentralFiles, aR as buildHotExports, aS as buildNodeMetrics, aT as buildReportContext, aU as buildSymbolCouplingPayload, aV as busFactorOf, aW as callGraphMetrics, aX as classifyCoupling, aY as collectNodeMetrics, aZ as collectSymbolUtil, a_ as compareExcess, a$ as complexityDistribution, b0 as computeArch, b1 as computeHealth, b2 as computePartitionQuality, b3 as computeReportDrift, b4 as computeSymbolConsumers, b5 as computeSymbolCoupling, b6 as dependencyGraphMetrics, b7 as filteredFileIds, b8 as groupTestsBySource, b9 as hotspotScoreOf, ba as importCyclicMass, bb as invertBuckets, bc as keepNode, bd as linkTestsToSources, be as lookupMetric, bf as packagesReferencedByEdges, bg as pairKey, bh as publicApiFiles, bi as qualitySection, bj as rebasedViolationKey, bk as referencedNodes, bl as summarizeComplexity, bm as testCoverageCountMetrics, bn as toSortedEdges, bo as topBusFactorRisks, bp as topCentralFiles, bq as topDeadModules, br as topGrowthRisks, bs as topHotspots, bt as topTestCoverageRisks, bu as topUntestedRisks, bv as topUnusedExports, bw as violationExcess, bx as violationKey } from './browser.js';
import { Db, Migration } from '@titan-design/store-sqlite';
import { FileSystemHost, Project } from 'ts-morph';
import { Extractor, ParsedFile } from '@titan-design/code-parser';
export { Extractor, ParsedFile, getLanguageFromPath, getSupportedLanguages, parseFile, shouldIncludeFile } from '@titan-design/code-parser';
import { C as ChurnEntry, a as ChurnWindow } from './change-coupling.js';
export { k as detectGitToplevel } from './change-coupling.js';
import { HeadMutation, HeadMutantsReport, Exec } from '@titan-design/fix-proof';
import { Embedder } from '@titan-design/embed';

/** One metric's values over the nodes of one kind in one snapshot; `count` excludes null values. */
interface MetricAggregate {
    name: string;
    nodeKind: NodeKind;
    count: number;
    sum: number | null;
    min: number | null;
    max: number | null;
}
/** One node's value for one metric, joined to the node's own vocabulary columns. */
interface TopMetricRow {
    nodeId: string;
    name: string;
    kind: string;
    role: string | null;
    value: number | null;
    unit: string | null;
}

interface SnapshotInsert {
    ref: string;
    commitHash?: string;
    indexVersion: string;
    attrs?: Record<string, unknown>;
}
/**
 * The code graph's query surface over store-sqlite's snapshot-scoped kit tables
 * plus this package's domain tables. Replaces codewatch's `GraphDatabase`: the
 * connection, pragmas, and migration runner are the kit's; what is left here is
 * the code-specific statements the indexer and its readers need.
 */
declare class CodeGraphStore {
    readonly db: Db;
    private readonly statements;
    private readonly targeted;
    constructor(db: Db);
    createSnapshot(input: SnapshotInsert): number;
    /**
     * Run `write` in one transaction so a reader on another connection sees a new
     * snapshot only once every row written for it is committed, never a snapshot
     * row whose nodes or edges are still being inserted. The per-table inserts
     * nest as savepoints inside it.
     */
    atomically<T>(write: () => T): T;
    insertNodes(snapshotId: number, nodes: readonly GraphNode[]): void;
    insertEdges(snapshotId: number, edges: readonly GraphEdge[]): void;
    insertMetrics(snapshotId: number, metrics: readonly GraphMetric[]): void;
    /**
     * Replace every metric of one `name` for a snapshot in a single transaction —
     * for an overlay such as coverage, which is re-ingested wholesale and must not
     * accumulate stale rows across runs.
     */
    replaceMetricsByName(snapshotId: number, name: string, metrics: readonly GraphMetric[]): void;
    insertAliases(snapshotId: number, aliases: readonly IdAlias[]): void;
    insertFingerprints(snapshotId: number, fingerprints: readonly FileFingerprint[]): void;
    getSnapshot(id: number): SnapshotRow | null;
    listSnapshots(opts?: {
        ref?: string;
        limit?: number;
    }): SnapshotRow[];
    getLatestSnapshotByRef(ref: string): SnapshotRow | null;
    getNode(snapshotId: number, id: string): GraphNode | null;
    /**
     * File-level structural graph by default: the per-symbol layer is excluded so
     * consumers that reason about module structure see the graph they expect. Pass
     * `includeSymbols` for the symbol layer (the reuse basis needs it).
     */
    listNodes(snapshotId: number, opts?: {
        includeSymbols?: boolean;
    }): GraphNode[];
    /** See {@link listNodes}: `references` and `calls` edges are the symbol layer, excluded by default. */
    listEdges(snapshotId: number, opts?: {
        includeReferences?: boolean;
    }): GraphEdge[];
    listMetrics(snapshotId: number): GraphMetric[];
    /** Every metric on one node, from the primary key instead of a whole-snapshot read. */
    listMetricsForNode(snapshotId: number, nodeId: string): GraphMetric[];
    /** Distinct metric names stored for a snapshot, ascending. */
    listMetricNames(snapshotId: number): string[];
    /** The highest-valued nodes for one metric, descending; `limit` defaults to 20. */
    topByMetric(opts: {
        snapshotId: number;
        metric: string;
        limit?: number;
        kind?: string;
    }): TopMetricRow[];
    /** Edges into or out of one node; symbol-layer edges are excluded unless asked, as in {@link listEdges}. */
    listEdgesTouching(snapshotId: number, nodeId: string, opts?: {
        includeReferences?: boolean;
    }): GraphEdge[];
    /** Count, sum, min, and max per metric name and node kind; pass `name` for one metric. */
    aggregateMetrics(snapshotId: number, opts?: {
        name?: string;
    }): MetricAggregate[];
    listAliases(snapshotId: number): IdAlias[];
    listFingerprints(snapshotId: number): FileFingerprint[];
    /** Drop whole snapshots. The domain tables carry no foreign key, so each is cleared by hand. */
    deleteSnapshots(ids: readonly number[]): void;
    vacuum(): void;
    countRowsByTable(tables: readonly string[]): Record<string, number>;
    close(): void;
}
/** Open (creating if absent) a code graph database and bring it to the current schema. */
declare function openCodeGraph(dbPath: string): CodeGraphStore;

/**
 * Kit table names. The code graph is snapshot-scoped end to end: a whole repo is
 * re-indexed together, so `snapshotTableDdl` + `entitySnapTableDdl` are the right
 * time model and the interval `edgeTableDdl` is not — one unchanged import would
 * otherwise write a row per file per snapshot. The edge table below is therefore
 * the snapshot-scoped counterpart, owned here.
 */
declare const KIT: {
    readonly snapshot: "snapshot";
    readonly entitySnap: "node";
    readonly cacheBlob: "blob_cache";
};
/**
 * Domain tables. `edge` is the snapshot-scoped edge shape (the kit's own edge
 * table is bi-temporal); `metric` holds index-time measurements keyed by node;
 * `id_alias` carries a node id across a rename so two snapshots line up; and
 * `file_fingerprint` is the reuse basis the incremental indexer diffs against.
 */
declare const DOMAIN_DDL = "\n  CREATE TABLE IF NOT EXISTS edge (\n    snapshot_id INTEGER NOT NULL,\n    src_id      TEXT NOT NULL,\n    dst_id      TEXT NOT NULL,\n    kind        TEXT NOT NULL,\n    attrs       TEXT,\n    PRIMARY KEY (snapshot_id, src_id, dst_id, kind)\n  );\n  CREATE INDEX IF NOT EXISTS idx_edge_dst ON edge(snapshot_id, dst_id);\n  CREATE INDEX IF NOT EXISTS idx_edge_kind ON edge(snapshot_id, kind);\n\n  CREATE TABLE IF NOT EXISTS metric (\n    snapshot_id INTEGER NOT NULL,\n    node_id     TEXT NOT NULL,\n    name        TEXT NOT NULL,\n    value       REAL,\n    unit        TEXT,\n    PRIMARY KEY (snapshot_id, node_id, name)\n  );\n  CREATE INDEX IF NOT EXISTS idx_metric_name ON metric(snapshot_id, name);\n\n  CREATE TABLE IF NOT EXISTS id_alias (\n    snapshot_id INTEGER NOT NULL,\n    old_id      TEXT NOT NULL,\n    new_id      TEXT NOT NULL,\n    reason      TEXT NOT NULL,\n    PRIMARY KEY (snapshot_id, old_id, new_id)\n  );\n\n  CREATE TABLE IF NOT EXISTS file_fingerprint (\n    snapshot_id     INTEGER NOT NULL,\n    file_id         TEXT NOT NULL,\n    content_hash    TEXT NOT NULL,\n    structural_hash TEXT,\n    PRIMARY KEY (snapshot_id, file_id)\n  );\n";
/**
 * Stored audit findings and model verdicts. `key` is a `findingKey`, not `Finding.id`,
 * because an external tool's id embeds its line number and can repeat within one audit.
 * The whole `Finding` and a verdict's citations live in `attrs`.
 */
declare const FINDING_DDL = "\n  CREATE TABLE IF NOT EXISTS finding (\n    snapshot_id  INTEGER NOT NULL,\n    key          TEXT NOT NULL,\n    finding_id   TEXT NOT NULL,\n    tool         TEXT NOT NULL,\n    signal       TEXT NOT NULL,\n    path         TEXT NOT NULL,\n    line_start   INTEGER,\n    line_end     INTEGER,\n    severity     TEXT NOT NULL,\n    excerpt_hash TEXT,\n    attrs        TEXT NOT NULL,\n    PRIMARY KEY (snapshot_id, key)\n  );\n  CREATE INDEX IF NOT EXISTS idx_finding_path ON finding(snapshot_id, path);\n\n  CREATE TABLE IF NOT EXISTS verdict (\n    snapshot_id  INTEGER NOT NULL,\n    key          TEXT NOT NULL,\n    verdict      TEXT NOT NULL CHECK (verdict IN ('confirmed', 'justified', 'unclear')),\n    rationale    TEXT NOT NULL,\n    excerpt_hash TEXT NOT NULL,\n    model        TEXT,\n    run_id       TEXT,\n    cost_usd     REAL,\n    provenance   TEXT,\n    control_run  TEXT,\n    carried_from INTEGER,\n    attrs        TEXT NOT NULL,\n    PRIMARY KEY (snapshot_id, key)\n  );\n";
/** Every table keyed by `snapshot_id`. No DDL above declares a foreign key, so dropping a snapshot walks this list. */
declare const SNAPSHOT_SCOPED_TABLES: readonly ["node", "edge", "metric", "id_alias", "file_fingerprint", "finding", "verdict"];
declare const MIGRATIONS: Migration[];
/** The top of this package's schema. A code graph database is never shared, so this is the top of one. */
declare const SCHEMA_VERSION$1: number;

interface PrunePlan {
    keep: SnapshotRow[];
    remove: SnapshotRow[];
}
interface PruneOptions {
    keep?: number;
    keepRefs?: readonly string[];
}
declare function planPrune(store: CodeGraphStore, options?: PruneOptions): PrunePlan;
interface PruneResult {
    plan: PrunePlan;
    rowsBefore: Record<string, number>;
    rowsAfter: Record<string, number>;
    vacuumed: boolean;
}
declare function runPrune(store: CodeGraphStore, options?: PruneOptions & {
    vacuum?: boolean;
}): PruneResult;

/**
 * Where the indexer reads a tree from. Every path is absolute and node ids are
 * derived from it, so a source that is not the working tree (a git commit, say)
 * keeps ids byte-identical by answering for the same absolute paths.
 */
interface IndexSource {
    /**
     * Source files under `rootDirs` that pass the ingest filter for `languages`,
     * deduped and sorted, so float metrics summed in file order match across sources.
     */
    listFiles(rootDirs: readonly string[], languages: readonly string[]): Promise<string[]>;
    /** UTF-8 content of a file; throws when it does not exist. */
    readFile(abs: string): string;
    fileExists(abs: string): boolean;
    /** The host ts-morph resolves imports and reads tsconfig through. */
    readonly fileSystem: FileSystemHost;
    /** Set when the source is a git commit rather than the working tree; undefined for the working tree. */
    readonly revision?: {
        /** The repo's toplevel, canonicalized with realpath. */
        readonly repoRoot: string;
        readonly commit: string;
        /** Committer time, seconds since the epoch. */
        readonly commitEpoch: number;
    };
}
/** The checked-out working tree, read through `node:fs`. The default source. */
declare function workingTreeSource(): IndexSource;

/**
 * Bumping this invalidates every reuse basis: a snapshot written by a different
 * index version is never reused, so a change to node/edge shape or to a metric's
 * value for the same bytes can never be carried forward from an incompatible graph.
 */
declare const INDEX_VERSION = "0.32.0";
interface IndexOptions {
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
interface IndexResult {
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
/**
 * Index one or more roots into a new snapshot: walk, read, parse what changed,
 * extract, annotate roles, compute metrics, and persist. Files unchanged since
 * the prior snapshot are carried forward rather than re-parsed, so the result
 * matches a full index regardless of how much was reused.
 */
declare function indexPaths(store: CodeGraphStore, options: IndexOptions): Promise<IndexResult>;

/**
 * Index `rev`'s tree from git objects, without a checkout and without writing to
 * the repo. Files keep their `<repo root>/<tree path>` absolute paths, so ids
 * match a working-tree index of the same commit. Workspace links into the repo
 * resolve to the commit; installed packages and untracked build output such as
 * a gitignored dist/ resolve against today's disk.
 */
declare function gitTreeSource(repoRoot: string, rev: string): IndexSource;

interface LanguageExtractorOptions {
    repoRoot: string;
    tsConfigPath?: string;
    source?: IndexSource;
}
/**
 * One extractor over every supported language: each delegate already returns an
 * empty fragment list for files it does not own, so dispatch is a fold. Keeps
 * `assembleFragments` language-agnostic.
 */
declare class LanguageExtractor implements Extractor<GraphFragment> {
    readonly name = "language-graph";
    private readonly delegates;
    constructor(options: LanguageExtractorOptions);
    extract(file: ParsedFile): GraphFragment[];
}

/**
 * Tree-sitter Python extraction. Deliberately narrower than the ts-morph side:
 * no type checker, so imports resolve by dotted path against the tree rather
 * than by symbol resolution, and symbols are the declarations the same
 * tree-sitter walk already finds for complexity. Enough to place Python files in
 * the graph with their dependencies; a semantic Python layer is a follow-up.
 */
declare class PythonGraphExtractor implements Extractor<GraphFragment> {
    private readonly repoRoot;
    private readonly source;
    readonly name = "python-graph";
    constructor(repoRoot: string, source?: IndexSource);
    extract(file: ParsedFile): GraphFragment[];
    private collectImports;
    /**
     * Resolve `a.b.c` (or a leading-dot relative import) to an in-repo file id by
     * walking the dotted path from the importing file's package and then from the
     * repo root, which covers both intra-package and root-relative layouts.
     */
    private resolveDotted;
}

interface TsMorphGraphExtractorOptions {
    repoRoot: string;
    tsConfigPath?: string;
    project?: Project;
    source?: IndexSource;
}
declare class TsMorphGraphExtractor implements Extractor<GraphFragment> {
    readonly name = "ts-morph-graph";
    private readonly repoRoot;
    private readonly tsConfigPath?;
    private project?;
    private readonly ownsProject;
    private readonly source;
    private readonly retired;
    private readonly fileExists;
    constructor(options: TsMorphGraphExtractorOptions);
    extract(file: ParsedFile): GraphFragment[];
    private retire;
    private extractFrom;
    private ensureProject;
    private loadSourceFile;
    private buildFileAndModuleNodes;
    private collectEdges;
    private recordImportEdge;
    /**
     * Split an import into per-export `references` edges targeting `symbol` nodes,
     * so per-symbol utilization (which exports are hot) falls out of the same
     * inbound-weight sum that powers file utilization (C-53). Extracted *forward*
     * from the importing file — source-local, exactly like the file-level import
     * weight — which sidesteps the reuse-breaking reverse `findReferences` query:
     * an unchanged file's outbound reference edges are carried forward verbatim.
     */
    private recordSymbolReferences;
    /**
     * Credit the exports a namespace import actually touches (TP-2474 c). A
     * whole-object use credits every export of the target, which is only
     * enumerable when ts-morph linked the target; otherwise only the named
     * members are credited, through the on-disk re-export walk. The export map is
     * read once per import, and never for an out-of-repo target.
     */
    private recordNamespaceReferences;
    /**
     * Resolve an imported name to the id of the `symbol` node for the export that
     * actually *declares* it — following re-exports through barrels via ts-morph's
     * own `getExportedDeclarations`, so `import { x } from "./barrel"` credits the
     * origin file's `x`, not the barrel. When ts-morph can't resolve the specifier
     * (e.g. an extensionless relative import), falls back to a filesystem-based
     * re-export walk that still sees through barrel hops (C-70). Returns null for
     * external / unresolved targets.
     * A name that resolves to no local declaration (an aliased re-export the
     * origin doesn't export under this name) yields a dangling edge, pruned after
     * assembly (`pruneDanglingReferences`).
     */
    private resolveSymbolTarget;
    private originSymbolId;
    private resolveReExportedSymbol;
    private recordReExportEdge;
    /**
     * Resolve an import/export specifier to a graph node id (an in-repo file id or
     * an `external` node, creating the external node on first sight), or `null`
     * when it should not produce an edge.
     */
    private resolveTarget;
    private resolveInternal;
    /**
     * Resolve a relative specifier ts-morph failed to link by walking the
     * filesystem from the importing file. ts-morph's NodeNext resolution only
     * links relative imports that carry an explicit `.js` extension, so
     * extensionless bundler-style imports (`../types`, common in code outside the
     * tsconfig project such as `dashboard/`) resolve to nothing and would
     * otherwise fall through to the `npm:` external bucket (C-44). Resolves
     * through the ts-morph filesystem host so it honours in-memory test fixtures.
     */
    private resolveRelativeInternal;
    private inRepoFileId;
}

/**
 * Build the `file` + `module` nodes for a source file from its path alone.
 * Path-derived and deterministic, so the incremental indexer can reconstruct an
 * unchanged file's nodes without re-parsing it — they are byte-for-byte the same
 * nodes the extractor would emit. Keep this the single source of truth for
 * file/module node shape.
 */
declare function buildFileModuleNodes(repoRoot: string, absPath: string): GraphNode[];

/**
 * C-81 — **deep AST on-pull**. Structural facts too heavy to persist at index
 * time (class members, per-parameter types, return type) are recomputed lazily
 * here from the working-tree source when a consumer actually pulls a target.
 * Persisting them would bloat every symbol node and break the incremental reuse
 * basis (inferred types embed absolute `import("…")` paths); computing on demand
 * keeps the index lean while still answering "what are the members / params of
 * this" for the one target being read.
 *
 * A single-file in-memory ts-morph project (no tsconfig, no dependency walk) —
 * so the extraction is cheap and reads only explicit syntactic annotations.
 */
interface ParamInfo {
    name: string;
    type: string | null;
}
interface MemberInfo {
    name: string;
    memberKind: string;
    signature: string | null;
    isStatic: boolean;
}
interface DeepAst {
    target: string;
    kind: "file" | "symbol";
    declarationKind: string | null;
    signature: string | null;
    purpose: string | null;
    params: ParamInfo[];
    returnType: string | null;
    /** Class/interface members for a symbol; exported declarations for a file. */
    members: MemberInfo[];
    note?: string;
}
interface DeepAstInput {
    /** Repo-relative file id, e.g. `src/a.ts`. */
    filePath: string;
    /** Absolute path to the file on disk. */
    absPath: string;
    /** Symbol name for a symbol target; omit for a file target. */
    symbolName?: string;
}
/** Deep structural facts for one target, or null when the source is unreadable. */
declare function computeDeepAst(input: DeepAstInput): DeepAst | null;

declare const SYMBOL_ID_SEP = "#";
declare function symbolId(fileId: string, qualifiedName: string): string;
/**
 * Inverse of {@link symbolId}: split a `<fileId>#<name>` symbol id back into its
 * declaring file and qualified name. Returns null for an id with no separator (a
 * plain file id), so callers can filter the symbol layer cleanly. `#` is illegal
 * in both posix paths and JS identifiers, so the first occurrence is the split.
 */
declare function parseSymbolId(id: string): {
    fileId: string;
    name: string;
} | null;

declare function fileId(repoRoot: string, absPath: string): string;
declare function moduleId(repoRoot: string, absPath: string): string;
declare function parentModuleId(id: string): string | null;
declare function packageId(name: string): string;

declare function externalId(specifier: string): string;

/**
 * Everything the metrics and alias passes need from one file's syntax tree,
 * computed while that tree is alive so the tree can be deleted right after
 * (TP-747: web-tree-sitter WASM memory never shrinks, so peak memory is set by
 * how many trees are alive at once).
 */
interface FileDigest {
    fileId: string;
    /** File-level metrics on `fileId` plus symbol-level metrics for every name in `symbolNames`. */
    sourceMetrics: GraphMetric[];
    deadCodeMetrics: GraphMetric[];
    growthRiskMetrics: GraphMetric[];
    /** Bare declared name to the qualified names that share it, for requalify aliases. */
    qualifiedByName: Map<string, Set<string>>;
}

/** SHA-256 of file content. The fingerprint that gates per-file reuse. */
declare function hashContent(content: string): string;
/**
 * Comment/whitespace-insensitive hash of a file's parse structure (C-18). Walks
 * the tree-sitter tree emitting each node's type plus leaf text, skipping comment
 * nodes; whitespace and positions are absent from the tree, so a pure reformat or
 * comment edit yields the SAME signature while any token change yields a new one.
 * Two files with an equal signature therefore produce identical edges and AST
 * metrics and differ only in line spans (and loc) — the COSMETIC reuse class.
 */
declare function structuralSignature(file: ParsedFile): string;
/** The languages that have an extractor; anything else is skipped by the walk. */
type SourceLanguage = "typescript" | "python";
interface ReadFile {
    filePath: string;
    language: SourceLanguage;
    content: string;
    hash: string;
}
/** Read + hash every source file. Cheap I/O; the parse/extract it gates is not. */
declare function readSourceFiles(filePaths: readonly string[], source?: IndexSource): Promise<ReadFile[]>;
/**
 * Everything from a prior snapshot needed to rebuild an unchanged file's
 * contribution to the graph without re-parsing it: its content fingerprint,
 * the node table (to look up external-node names), outbound edges grouped by
 * source file (a symbol's `calls` edges under the file declaring it), and the source-content metrics (loc, complexity, lcom4, ...).
 */
interface ReuseBasis {
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
 * Recursively collect the source files under `rootDirs` that pass the ingest
 * filter for `languages`, deduped by absolute path across roots (walk order
 * preserved). Extracted from the indexer (C-61): as a function nested inside the
 * per-root loop, the recursive walker carried a cognitive-complexity nesting
 * bonus that made it the indexer's single most complex function (cx 19, above
 * the exported entry point). Hoisting it here — one recursion helper, one
 * directory branch — drops it well under budget and makes the walker unit-
 * testable in isolation.
 */
declare function walkSourceFiles(rootDirs: readonly string[], languages: readonly string[]): Promise<string[]>;

/** 1-based inclusive line span of a declaration, for coverage range-attribution (C-63). */
interface LineSpan {
    startLine: number;
    endLine: number;
}
/**
 * Qualified declared names mapped to their 1-based line span (C-63 coverage
 * range-containment). One scope binds a name once, as TypeScript and Python do,
 * so a getter/setter pair, a Python property's accessors, and `@overload` stubs
 * share one entry; when a qualified name repeats, the last span wins.
 */
declare function collectDeclaredSpans(file: ParsedFile): Map<string, LineSpan>;
/** Declared names only — the Set view over {@link collectDeclaredSpans}. */
declare function collectDeclaredNames(file: ParsedFile): Set<string>;

/** Edge weight (C-51 reference count), floored at 1 for unweighted edges. */
declare function edgeWeight(e: GraphEdge): number;
/**
 * Drop `references` edges (C-53) whose target `symbol` node doesn't exist — an
 * aliased re-export chain, or a barrel that changed under a reused file, can
 * resolve a name to an origin that doesn't declare it. `calls` edges (TP-323)
 * are dropped the same way, which is how a callee name that maps to no symbol
 * node is discarded rather than guessed. Only these two can dangle
 * (imports/re-exports resolve to always-emitted file/external nodes). Mutates
 * `edges` in place.
 */
declare function pruneDanglingReferences(nodes: ReadonlyMap<string, GraphNode>, edges: Map<string, GraphEdge>): void;
/**
 * Resolve edges that land on a barrel (`role="barrel"` — a bare `index.*`
 * re-export file) onto the files the barrel actually re-exports from, so
 * downstream signals measure the real dependency surface instead of the
 * re-export plumbing. A cross-package `import … from "@codewatch/graph"`
 * resolves to the barrel; without this every such import piles onto the barrel
 * as an artificial hub while the module that truly does the work is
 * under-credited.
 *
 * An inbound edge `F → B` (weight w) is split across B's outbound re-export
 * targets `t_i` in proportion to each target's re-export weight `r_i` (C-51:
 * the count of names B forwards from `t_i`). This CONSERVES w — no magnitude
 * inflation, unlike a uniform fan-out that turns one import into N edges — and
 * attributes it by how much of the barrel each target supplies. Resolution
 * recurses through barrel chains (a barrel re-exporting a barrel) with a
 * visited guard against re-export cycles; a barrel with no resolvable
 * re-exports is left as its own target so the dependency is never dropped.
 *
 * Pure over the assembled node/edge set, so it is deterministic regardless of
 * how much of an incremental index was reused.
 */
declare function resolveBarrelEdges(nodes: readonly GraphNode[], edges: readonly GraphEdge[]): GraphEdge[];

/**
 * Repo-configured role globs, read from `.codewatch/roles.json`. They label
 * paths no filename convention can (a design system's `lab/` playground is
 * too generic a directory name to guess), and they beat the built-in role
 * heuristics. Globs use `.gitattributes` syntax, matched against file ids.
 */
type RoleGlobs = Partial<Record<NodeRole, string[]>>;

declare const ALL_ROLES: readonly NodeRole[];
interface RoleHints {
    /** File begins with a `#!` shebang, i.e. it is an executable entry point. */
    hasShebang?: boolean;
    /** File is codegen output (`.gitattributes linguist-generated` or heuristic). */
    isGenerated?: boolean;
    /** Role a `.codewatch/roles.json` glob assigns this file. */
    configuredRole?: NodeRole;
}
declare function classifyRole(id: string, hints?: RoleHints): NodeRole;
interface AnnotateRolesOptions {
    /** Node ids whose source begins with a `#!` shebang. */
    shebangIds?: ReadonlySet<string>;
    /** Node ids detected as generated (codegen output). */
    generatedIds?: ReadonlySet<string>;
    /** Configured role globs; see {@link loadRoleGlobs}. */
    roleGlobs?: RoleGlobs;
}
/** Read `<rootDir>/.codewatch/roles.json`; a repo without one configures no globs. */
declare function loadRoleGlobs(rootDir: string, source?: IndexSource): RoleGlobs;
interface ReadFileLike {
    filePath: string;
    content: string;
}
/**
 * Derive per-file role hints for a batch of read files in one pass: the shebang
 * set (executable entries) and the generated set (codegen output, detected via
 * `.gitattributes linguist-generated` under `idRoot` plus filename/path
 * heuristics). Lives here so the indexer stays at its file-size ceiling.
 */
declare function computeRoleHints(readFiles: readonly ReadFileLike[], idRoot: string, toId: (root: string, filePath: string) => string, source?: IndexSource): AnnotateRolesOptions;
declare function annotateRoles(nodes: readonly GraphNode[], options?: AnnotateRolesOptions): GraphNode[];

/**
 * Roles of files nothing imports by design, so reachability and dead-export
 * reports treat them as roots. One list, typed by role, so a new role cannot be
 * added to one report and missed in another. It lives apart from `roles.ts`,
 * which reads files, so browser-safe report code can import it.
 */
declare const UNIMPORTED_ROLES: ReadonlySet<NodeRole>;

/** True when a path looks generated by filename/dir convention alone. */
declare function isGeneratedByHeuristic(id: string): boolean;
/**
 * A file is generated when it matches a repo-declared `linguist-generated`
 * pattern or the filename/path heuristic. `patterns` come from
 * {@link parseGeneratedPatterns}; pass `[]` when no `.gitattributes` exists.
 */
declare function isGeneratedFile(id: string, patterns: readonly RegExp[]): boolean;
/** Read `<rootDir>/.gitattributes` and compile its linguist-generated patterns. */
declare function loadGeneratedPatterns(rootDir: string, source?: IndexSource): RegExp[];

declare function canonicalMetricName(name: string): string;
declare function canonicalRole(name: string): string;
declare function canonicalEdgeKind(name: string): string;

interface RenamePair {
    oldPath: string;
    newPath: string;
    similarity: number;
}
interface DetectRenamesOptions {
    repoRoot: string;
    fromCommit: string;
    toCommit?: string;
    similarityThreshold?: number;
}
declare function detectGitHead(repoRoot: string): string | null;
declare function isInsideGitRepo(repoRoot: string): boolean;

/** Resolve a ref (branch, tag, sha) to its current commit sha, or null. */
declare function resolveGitRef(repoRoot: string, ref: string): string | null;
declare function detectRenames(options: DetectRenamesOptions): RenamePair[];
declare function buildAliases(repoRoot: string, pairs: readonly RenamePair[]): IdAlias[];

/** Snapshot attrs key naming the snapshot its id aliases were computed against; written from index version 0.15.0. */
declare const ALIAS_BASE_ATTR = "aliasBase";
type LineageSnapshot = Pick<SnapshotRow, "id" | "commitHash" | "attrs">;
/** Each snapshot's alias base, or null for a root: the tree the id_alias rows form across snapshots. */
type Lineage = ReadonlyMap<number, number | null>;
interface LineageStep {
    snapshotId: number;
    /** `forward` applies the snapshot's aliases (base to snapshot); `backward` undoes them. */
    direction: "forward" | "backward";
}
/**
 * The recorded base per snapshot. A snapshot written before 0.15.0 records none,
 * so it gets the newest earlier snapshot with a commit: the one the indexer diffed against then.
 */
declare function buildLineage(snapshots: readonly LineageSnapshot[]): Lineage;
/** Steps from one snapshot to another through their nearest common base, or null when they share none. */
declare function lineagePath(lineage: Lineage, fromId: number, toId: number, maxHops?: number): LineageStep[] | null;

type AliasLoader = (snapshotId: number) => readonly IdAlias[];
interface AliasResolution {
    requestedId: string;
    /** The id in the target snapshot's id space; equal to `requestedId` when nothing moved. */
    id: string;
    /** Each alias applied in walk order; a backward step lists the alias it undid. */
    hops: IdAlias[];
    /** `move` when any hop changed directory, otherwise the last hop's reason; absent without hops. */
    reason?: IdAliasReason;
}
interface AliasChain {
    fromSnapshotId: number | null;
    toSnapshotId: number;
    /** False when the snapshots share no alias base; only the target's own aliases apply then, as before 0.15.0. */
    connected: boolean;
    steps: readonly LineageStep[];
    resolve(id: string): string;
    trace(id: string): AliasResolution;
}
interface AliasChainInput {
    lineage: Lineage;
    loadAliases: AliasLoader;
    /** Null resolves an id from any ancestor of `to`. */
    from: number | null;
    to: number;
    maxHops?: number;
}
/** Carry node ids from one snapshot into another across every rename between them. */
declare function createAliasChain(input: AliasChainInput): AliasChain;

interface AliasChainOptions {
    maxHops?: number;
}
interface ResolveAliasOptions extends AliasChainOptions {
    /** The snapshot the id was read in; omitted, the id may come from any ancestor of the target. */
    fromSnapshotId?: number;
}
interface PriorSnapshotOptions {
    /** Only snapshots older than this id count; omitted, every snapshot does. */
    before?: number;
    /** A git checkout to resolve `ref` in; without it only the snapshot's `ref` label matches. */
    repoRoot?: string;
}
/** The alias-base tree over every snapshot in the store. */
declare function loadLineage(store: CodeGraphStore): Lineage;
/** Carry node ids from `fromSnapshotId` into `toSnapshotId` through every alias between them, in either direction. */
declare function aliasChain(store: CodeGraphStore, fromSnapshotId: number | null, toSnapshotId: number, options?: AliasChainOptions): AliasChain;
/** Resolve an id to its form in `toSnapshotId`: `a.ts` renamed to `b.ts` then `c.ts` resolves to `c.ts`. */
declare function resolveAlias(store: CodeGraphStore, id: string, toSnapshotId: number, options?: ResolveAliasOptions): AliasResolution;
/**
 * The newest snapshot a ref denotes: first the snapshot of the commit git resolves
 * `ref` to (with `repoRoot`), else the newest snapshot whose `ref` label is `ref`.
 */
declare function priorSnapshotForRef(store: CodeGraphStore, ref: string, options?: PriorSnapshotOptions): SnapshotRow | null;

declare function computeMetrics(nodes: readonly GraphNode[], edges: readonly GraphEdge[]): GraphMetric[];

/**
 * Names of every metric `computeSourceMetrics` can emit. These are pure
 * functions of a file's content, so the incremental indexer can carry them
 * forward unchanged for a byte-identical file instead of re-parsing it. If a
 * new source metric is added above, add its name here — the incremental
 * round-trip test will fail loudly if this set drifts out of sync.
 */
declare const SOURCE_METRIC_NAMES: ReadonlySet<string>;
/**
 * Per-file source metrics. `symbolNamesByFile` maps a file id to the names of
 * the `symbol` nodes it declares; when supplied, per-function complexity is
 * emitted on those symbol nodes (C-58; all declared functions since C-64). It
 * defaults to empty, so existing callers/tests that don't thread the symbol
 * layer keep emitting only file-level metrics.
 */
declare function computeSourceMetrics(files: readonly ParsedFile[], fileIdOf: (filePath: string) => string, symbolNamesByFile?: ReadonlyMap<string, ReadonlySet<string>>): GraphMetric[];

declare const SYMBOL_METRIC_NAMES: readonly string[];

/**
 * Exception-handling metrics (TP-322), pure functions of one file's bytes. A
 * handler is swallowed when all it does is nothing, skip, bail out empty, or
 * log: the error stops here and no caller learns of it. Written on every file,
 * zeros included, so percentiles over a snapshot see the clean files too.
 */
declare const EXCEPTION_METRIC_NAMES: readonly string[];

interface HistoryMetricsOptions {
    /** Primary window: scopes ownership. Default 30. */
    churnWindowDays?: number;
    /** Windows to store churn and recency for; default {@link DEFAULT_CHURN_WINDOWS}, primary always included. */
    churnWindows?: number[];
    /** Also store an all-time `lifetime` window over full git history. */
    includeLifetime?: boolean;
    /** Epoch seconds that windows end at; defaults to the current time. */
    nowEpoch?: number;
    /** Read history up to this rev instead of HEAD; pair it with the rev's commit time as `nowEpoch`. */
    rev?: string;
    /** Day windows to store per-symbol accretion for; default {@link DEFAULT_ACCRETION_WINDOWS}, [] turns it off. */
    accretionWindows?: number[];
    /** Task ids read from commit subjects for `symbol_task_ids_{w}`; default `DEFAULT_TASK_ID_PATTERN`. */
    taskIdPattern?: RegExp;
}
/** Re-edits of one function across distinct tasks within a week is the accretion signal the slop audit asked for. */
declare const DEFAULT_ACCRETION_WINDOWS: number[];
/** Windows the dashboard switcher offers; churn is stored for each by default. */
declare const DEFAULT_CHURN_WINDOWS: number[];
/** De-duped, ascending windows including the primary, with `lifetime` last (widest) when requested. */
declare function resolveChurnWindows(requested: number[] | undefined, primaryWindow: number, includeLifetime: boolean): ChurnWindow[];
interface LoadedHistory {
    metrics: GraphMetric[];
    /** Churn entries inside the primary window, which also scopes test-coverage linking and ownership. */
    primaryEntries: readonly ChurnEntry[];
    /**
     * Why history is missing or partial: the churn log overflowed or git failed (no metrics, no entries),
     * or the first-seen log did (metrics without age discount). Empty when everything loaded.
     */
    warnings: readonly string[];
}
/** {@link buildHistoryMetrics} plus the primary-window entries it read. Null when `idRoot` is not a git checkout;
 * `warnings` (and no metrics) when git ran but its log overflowed or failed. */
declare function loadHistoryMetrics(nodes: Iterable<GraphNode>, idRoot: string, options?: HistoryMetricsOptions): LoadedHistory | null;
interface TestCoverageOwnershipOptions {
    /** Window named in the metric suffix. Default 30. */
    windowDays?: ChurnWindow;
    /** Coverage threshold for bus factor (default 0.5 = 50% of churn). */
    busFactorThreshold?: number;
}
/**
 * Bus-factor / top-author-share of the *test coverage* for each source, keyed
 * on the source node. Aggregates churn authorship across all test files linked
 * to a source (via the two-pass linker) and summarises it the same way as
 * production ownership — so a file can read as well-spread on production code
 * yet a single-author silo on its tests (or vice versa). Emitted only for
 * sources with at least one linked test that has churn in the window.
 */
declare function computeTestCoverageOwnership(entries: readonly ChurnEntry[], links: readonly TestSourceLink[], options?: TestCoverageOwnershipOptions): GraphMetric[];

interface IndexerMetricsInput {
    nodes: Map<string, GraphNode>;
    edges: Map<string, GraphEdge>;
    /** Files (re)parsed this run — source metrics are computed fresh for these. */
    parsedFiles?: ParsedFile[];
    /**
     * Digests of the files (re)parsed this run, used in place of `parsedFiles` so
     * their trees can be deleted before metrics run (TP-747).
     */
    fileDigests?: readonly FileDigest[];
    /** Source metrics carried forward verbatim for reused (unchanged) files. */
    reusedSourceMetrics: GraphMetric[];
    idRoot: string;
    /** Git-history metrics (churn, recency, ownership); omitted means none. */
    history?: HistoryMetricsOptions;
    /** Python console-script targets (`pkg.cli:main`) that make their function an output boundary. */
    entryPoints?: readonly string[];
}
/**
 * Assemble the metric set for a snapshot: graph-wide degree metrics over the
 * full node/edge set, freshly-computed source metrics for (re)parsed files, and
 * reused source metrics carried forward for unchanged files. Everything but the
 * reused source metrics is recomputed over the full set, so the result matches a
 * full index regardless of how much was reused.
 *
 * Git-history metrics come from the path-based engine in `./history/` through
 * the `history-metrics.ts` adapter. Test-coverage metrics run with or without it.
 */
declare function buildIndexerMetrics(input: IndexerMetricsInput): GraphMetric[];
interface AssembledIndexerMetrics {
    metrics: GraphMetric[];
    /** Why git-history metrics are missing or partial; empty when history loaded or the root is not git. */
    warnings: readonly string[];
}
/** {@link buildIndexerMetrics} plus the history warnings it would otherwise drop. */
declare function assembleIndexerMetrics(input: IndexerMetricsInput): AssembledIndexerMetrics;

/**
 * Function-local dead-code metrics (C-65 Phase 1). Pure functions of one file's
 * bytes — the same class as the source metrics in source-metrics.ts — so they
 * ride the content-hash incremental reuse gate. Kept in their own module (not
 * appended to source-metrics.ts) so the already-churn-hot source-metrics.ts is
 * not touched; the reuse machinery folds these names in alongside
 * SOURCE_METRIC_NAMES (see incremental.ts) and index-metrics.ts computes them
 * fresh for (re)parsed files.
 */
declare const DEAD_CODE_METRIC_NAMES: ReadonlySet<string>;
/**
 * Per-file dead-code metrics for TypeScript and Python files (Python since
 * TP-318, in dead-code-python.ts). Emitted sparsely — only when a count is > 0 —
 * so a clean file adds no rows (a full index and an incremental re-index
 * therefore produce the identical metric set). Other languages are skipped.
 */
declare function computeDeadCodeMetrics(files: readonly ParsedFile[], fileIdOf: (filePath: string) => string): GraphMetric[];

/**
 * Growth-risk / scaling-smell metrics (C-66 Phase 2). Cheap, function-local
 * *heuristics* — NOT Big-O or a proven complexity class (real asymptotic
 * inference is undecidable; see the roadmap's hard NO). Pure functions of one
 * file's bytes, so they ride the content-hash incremental reuse gate, folded
 * into the carry-forward set in incremental.ts alongside the source/dead-code
 * metric names. Emitted sparsely (only when a smell is present).
 */
declare const GROWTH_RISK_METRIC_NAMES: ReadonlySet<string>;
/**
 * Per-file growth-risk metrics for TS/Python files, all SMELLS not bounds:
 * - `loop_depth` — max *lexical* loop nesting (triple-nested → 3), emitted at
 *   depth ≥ 2 (depth-2 loops over two *different* collections are actually linear).
 * - `recursive_functions` — named functions that call themselves directly.
 * - `search_in_loop` — linear-scan method calls (`.includes`/`.find`/…) inside a
 *   loop (an O(n) scan per iteration; `.includes` on a `Set` is O(1)).
 * All emitted sparsely (only when present). Non-TS/Python files are skipped.
 */
declare function computeGrowthRiskMetrics(files: readonly ParsedFile[], fileIdOf: (filePath: string) => string): GraphMetric[];

/**
 * Coverage is a whole-suite DYNAMIC artifact — a function of *which tests ran*,
 * not of any file's bytes — so it must NOT ride the content-hash reuse gate. It
 * is emitted as a `coverage_pct` metric that is deliberately absent from every
 * *_METRIC_NAMES reuse set, so an incremental index never carries it forward: a
 * later index produces a snapshot with NO coverage until re-ingested. That is the
 * overlay semantics — coverage is attached to the snapshot it was measured
 * against and never inferred for another.
 */
declare const COVERAGE_METRIC_NAME = "coverage_pct";
/** Minimal Istanbul `coverage-final.json` shape we read (function-level). */
interface IstanbulFn {
    loc: {
        start: {
            line: number;
        };
        end: {
            line: number;
        };
    };
}
interface IstanbulFileCoverage {
    fnMap: Record<string, IstanbulFn>;
    /** Per-function hit counts, keyed to fnMap ids. */
    f: Record<string, number>;
}
type IstanbulCoverage = Record<string, IstanbulFileCoverage>;
/** A symbol node's 1-based line span, for range-containment attribution. */
interface SymbolSpan {
    id: string;
    startLine: number;
    endLine: number;
}
/**
 * Attribute an Istanbul coverage report to graph nodes as `coverage_pct` metrics:
 * one per covered FILE (covered functions / total functions), and one per SYMBOL
 * a covered function maps into by RANGE containment (symbol spans) — matching
 * by range, not name, so anonymous/mangled Istanbul function names are handled.
 * A symbol spanning several functions (a class) reports its methods' coverage
 * ratio. Files Istanbul reports but the graph doesn't know are skipped.
 */
declare function attributeCoverage(coverage: IstanbulCoverage, fileIdOf: (absPath: string) => string | null, symbolsByFile: ReadonlyMap<string, readonly SymbolSpan[]>): GraphMetric[];
/** Start lines of functions Istanbul saw run at least once, by repo path; files it does not map are absent. */
declare function coveredFunctionStarts(coverage: IstanbulCoverage, fileIdOf: (absPath: string) => string | null): Map<string, Set<number>>;

declare const MAX_BODY_DELETES = 10;
interface BodyDeleteTarget {
    nodeId: string;
    file: string;
    symbol: string;
    lineStart: number;
    lineEnd: number;
    mutation: HeadMutation;
}
type BodyDeleteSkip = "uncovered" | "unchanged" | "expression-body" | "constructor" | "generator" | "overload-or-abstract" | "find-not-unique" | "find-over-cap" | "capped";
interface BodyDeletePlan {
    targets: BodyDeleteTarget[];
    skipped: Array<{
        nodeId: string;
        reason: BodyDeleteSkip;
    }>;
}
interface PlanBodyDeletesInput {
    /** Repo-relative path → head text, TS/TSX source only. */
    files: ReadonlyMap<string, string>;
    /** Path → head-side inclusive line ranges from `-U0` hunks. */
    changed: ReadonlyMap<string, readonly (readonly [number, number])[]>;
    /** Path → start lines of functions Istanbul saw run at least once. */
    covered: ReadonlyMap<string, ReadonlySet<number>>;
    max?: number;
    /** The head sha, so a rerun at the same head samples the same targets. */
    seed: string;
}
/**
 * One early-return mutant per changed, covered, block-bodied function in `files`; every other function declaration, method,
 * arrow or function expression is skipped with a reason. Accessors are not considered. Over `max`, a sample seeded by `seed` is kept and the rest are `capped`. Pure: nothing is read or written.
 */
declare function planBodyDeletes(input: PlanBodyDeletesInput): BodyDeletePlan;

/** One tool-neutral audit finding; every finding cites a path so a citation checker can verify it. */
interface Finding {
    id: string;
    path: string;
    lineStart?: number;
    lineEnd?: number;
    symbol?: string;
    signal: string;
    value?: number;
    baseline?: number;
    threshold?: number;
    severity: Severity;
    evidence?: string;
    tool: string;
}
/** A diagnostic from an outside linter, shaped structurally so no linter package is imported. */
interface ExternalDiagnostic {
    tool: string;
    rule: string;
    file: string;
    line: number;
    endLine?: number;
    message: string;
    severity: "error" | "warning";
}
declare function toFindings(result: CheckResult): Finding[];
declare function externalToFinding(input: ExternalDiagnostic): Finding;

declare const PSEUDO_TESTED_SIGNAL = "pseudo-tested";
declare const DELETION_CANDIDATE_SIGNAL = "test-deletion-candidate";
/**
 * Counts only; no key is a score, rate, ratio or percentage. Every target is exactly one of survived, caught, caughtError,
 * excluded (unrun, unapplied, unbuilt, load-error or timeout) and unverified (survived its own package's suite, but a test
 * file outside that suite reaches it).
 */
interface ExtremeSummary {
    head: string;
    targets: number;
    survived: number;
    caught: number;
    caughtError: number;
    excluded: number;
    unverified: number;
    /** Runs whose failure list hit fix-proof's cap; tests in their suites are never deletion candidates. */
    truncated: number;
    skipped: Record<BodyDeleteSkip, number>;
    deletionCandidates: number;
    builds: number;
    wallMs: number;
}
interface ExtremeFindingsInput {
    plan: BodyDeletePlan;
    report: HeadMutantsReport;
    /** Source files a test file imports, transitively. */
    reachedFiles: (testFile: string) => ReadonlySet<string>;
    /** Every test file at head, so a target tested only from a suite that never ran is not read as survived. */
    testFiles: readonly string[];
}
/**
 * Reads a head-mode run of body-delete mutants as `pseudo-tested` findings (a covered function whose early return no test
 * in its package noticed) and `test-deletion-candidate` findings (a test that noticed none of the mutants it reaches). Both
 * are advisory warnings; nothing is scored and nothing is deleted.
 */
declare function extremeFindings(input: ExtremeFindingsInput): {
    findings: Finding[];
    summary: ExtremeSummary;
};

interface ExtremeMutationOptions {
    /** The git toplevel. */
    repo: string;
    head: string;
    /** Repo path → head-side inclusive line ranges from `-U0` hunks. */
    changed: ReadonlyMap<string, readonly (readonly [number, number])[]>;
    /** A whole-suite Istanbul `coverage-final.json` and the commit it was measured at, which must be `head`. */
    coverage: {
        head: string;
        data: IstanbulCoverage;
    };
    /** A snapshot at head, read only for its import edges. */
    store: Pick<CodeGraphStore, "listEdges">;
    snapshotId: number;
    max?: number;
    budgetMs?: number;
    sandboxUser?: string;
    exec?: Exec;
}
interface ExtremeMutationResult {
    findings: Finding[];
    summary: ExtremeSummary;
    report: HeadMutantsReport;
}
/**
 * Body-deletes each changed, covered function at head, runs its owning package's tests against it in fix-proof's throwaway
 * worktree, and reads the outcomes as findings. Nothing outside that worktree is written. Throws only when the coverage was
 * not measured at head or the head's fix-proof config does not parse.
 */
declare function runExtremeMutation(o: ExtremeMutationOptions): Promise<ExtremeMutationResult>;

type MinifyLanguage = "typescript" | "tsx" | "python";
/**
 * Minified source plus its line map. `lineMap[i]` is the 1-based original line
 * of output line `i + 1`; `originalLine` reads it by output line number.
 */
interface MinifiedSource {
    text: string;
    lineMap: number[];
}
/** The one line that stands in for a leading import block. */
declare function importMarker(count: number, language: MinifyLanguage): string;
/** The 1-based original line of a 1-based output line, or undefined past the end. */
declare function originalLine(minified: MinifiedSource, outputLine: number): number | undefined;
declare function isMinifyLanguage(language: string): language is MinifyLanguage;
/**
 * Safe-minify source for LLM context: drops comments and docstrings, strips
 * trailing whitespace, collapses blank-line runs and replaces a leading import
 * block with `importMarker`. It never renames or dedents, so every kept line is
 * its original line minus comments. Any other language comes back unchanged
 * with an identity line map.
 */
declare function minifySource(text: string, language: string): Promise<MinifiedSource>;

/** Metric-name suffix for a window: `30d`, `180d`, or `lifetime`. */
declare function windowSuffix(window: ChurnWindow): string;
/**
 * Age-discount metrics: `recency_{w}` = min(1, age/w) for each file that churned
 * in window `w`, plus one window-independent `file_age_days` per file. Multiplying
 * a hotspot score by recency stops a young file's burst of churn from reading as
 * decay. Recency is emitted (as 1) even when the age is unknown, so a rule that
 * needs every hotspot factor is never silently disabled; `file_age_days` only when known.
 */
declare function computeRecencyWindows(firstSeen: ReadonlyMap<string, number>, churnedIdsByWindow: ReadonlyMap<ChurnWindow, ReadonlySet<string>>, nowEpoch: number): GraphMetric[];

interface PageRankOptions {
    /** Per-node teleport weight. Unset or empty → uniform teleport across all nodes. */
    personalization?: ReadonlyMap<string, number>;
    /** Probability of following an edge vs teleporting (default 0.85). */
    damping?: number;
    /** L1 convergence threshold (default 1e-6). */
    tolerance?: number;
    /** Cap on power-iteration steps (default 100). */
    maxIterations?: number;
    /** Per-kind edge weight; missing kinds default to 1.0. */
    edgeWeights?: Partial<Record<EdgeKind, number>>;
}
interface PageRankRow {
    nodeId: string;
    score: number;
}
interface PageRankResult {
    /** Sorted descending by score; ties broken by node id ascending. */
    rows: PageRankRow[];
    iterations: number;
    converged: boolean;
}
/** Edge weight used by PageRank for a given edge kind, honoring user overrides. */
declare function getEdgeWeight(kind: EdgeKind, overrides?: Partial<Record<EdgeKind, number>>): number;
declare function computePageRank(nodes: readonly GraphNode[], edges: readonly GraphEdge[], options?: PageRankOptions): PageRankResult;

interface RelevanceOptions {
    /** Probability of following an edge vs teleporting back to the seeds (default 0.85). */
    damping?: number;
    /** Per-kind edge weight override, forwarded to PageRank. */
    edgeWeights?: PageRankOptions["edgeWeights"];
}
/**
 * C-89 — **seeded (personalized) PageRank as a relevance-to-target proximity
 * measure** (Aider RepoMap-style). The teleport vector is concentrated on
 * `seedIds`, so the stationary distribution scores every node by how tightly it
 * couples to the seeds through the resolved dependency graph: near neighbours
 * score high, decaying with graph distance. This is "relevance to what I'm
 * looking at," distinct from global PageRank centrality ("globally famous"),
 * which stays the no-seed cold path.
 *
 * The edge set is **symmetrized** (each edge added in both directions) so
 * relevance flows to a target's callers AND its dependencies — a purely forward
 * walk from the seed would only reach what the seed depends on, never who
 * depends on it. Edge kind (and therefore weight) is preserved on the reversed
 * copy, so a heavier `calls` edge stays heavier in both directions.
 *
 * Returns a Map from node id to relevance score (seeds included). An empty seed
 * set returns an empty map — callers then fall back to global centrality.
 */
declare function computeRelevance(nodes: readonly GraphNode[], edges: readonly GraphEdge[], seedIds: readonly string[], options?: RelevanceOptions): Map<string, number>;

interface CallPathOptions {
    /** Edge kinds the path may follow. Defaults to `calls`. */
    kinds?: readonly EdgeKind[];
}
/**
 * One edge of a coarser level, such as a repo-map/v1 aggregate edge. Structural, so a
 * caller passes graph-layout's `MapEdge` without code-graph importing a higher tier.
 */
interface LevelEdge {
    id: string;
    source: string;
    target: string;
}
/** One hop of a path projected to a level, riding that level's aggregate edge `edgeId`. */
interface ProjectedHop {
    from: string;
    to: string;
    edgeId: string;
}
/**
 * The shortest directed path from `from` to `to`, as node ids, or null when none exists.
 * Among equally short paths it returns the one whose id sequence sorts first: breadth-first
 * search over id-sorted neighbours reaches every node first along that path.
 */
declare function findCallPath(edges: readonly GraphEdge[], from: string, to: string, options?: CallPathOptions): string[] | null;
/** {@link findCallPath} over one snapshot's stored edges, the symbol layer's `calls` included. */
declare function snapshotCallPath(store: CodeGraphStore, snapshotId: number, from: string, to: string, options?: CallPathOptions): string[] | null;
/**
 * Project a node path to a coarser level. `groupOf` maps a node to its box at that level
 * (graph-layout's repo-map levels live a tier above, so the caller supplies the mapping).
 * Consecutive nodes in one box fold into one stop; a revisit (a, b, a) stays three stops,
 * so a round trip is never erased. Each hop names the level edge it rides and throws when
 * the level has none, because a hop with no edge has no route to animate along.
 */
declare function projectCallPath(path: readonly string[], groupOf: (nodeId: string) => string, levelEdges: readonly LevelEdge[]): ProjectedHop[];

type ProtocolKind = "http" | "mcp" | "sse";
/** One source file by its graph file id (repo-relative path) and its text. */
interface ProtocolSourceFile {
    path: string;
    text: string;
}
/** Something a server declares: an HTTP route or SSE stream (`GET /a/:id`) or an MCP tool name. */
interface ProtocolEndpoint {
    kind: ProtocolKind;
    name: string;
    fileId: string;
    line: number;
}
/** A runtime call from the file that makes it to the file that serves it, one way. */
interface ProtocolEdge {
    srcId: string;
    dstId: string;
    kind: ProtocolKind;
    /** The endpoint's name, as in {@link ProtocolEndpoint.name}. */
    endpoint: string;
    /** What the arrow reads, such as `HTTP GET /a/:id`, `SSE /events` or `MCP search`. */
    label: string;
    /** The caller's 1-based line. */
    line: number;
}
/** Named so a consumer (RX2) can surface it: no file declares a route, a stream or a tool. */
declare const NO_PROTOCOL_SOURCE = "no-protocol-source";
interface ProtocolDiagnostic {
    code: typeof NO_PROTOCOL_SOURCE;
    message: string;
}
interface ProtocolEdgeResult {
    endpoints: ProtocolEndpoint[];
    edges: ProtocolEdge[];
    diagnostics: ProtocolDiagnostic[];
}
/**
 * The HTTP route, SSE stream and MCP tool edges between a repo's files, read from source
 * text alone (no type checker), so it runs on any checkout. A call becomes an edge only when
 * its path or tool name is literal enough to match one declared endpoint; a route whose
 * handler streams `text/event-stream` (or calls hono's `streamSSE`) is an SSE endpoint.
 * With no endpoint declared anywhere, the result carries {@link NO_PROTOCOL_SOURCE}: a map
 * drawn from it has import arrows only.
 */
declare function extractProtocolEdges(files: readonly ProtocolSourceFile[]): ProtocolEdgeResult;

/** Marks a gap between two symbols that are not adjacent in their file. */
declare const ELISION_MARKER = "...";
/** Ends a line cut at `maxLineChars`; it counts toward the limit. */
declare const TRUNCATION_SUFFIX = "\u2026";
declare const DEFAULT_MAX_LINE_CHARS = 120;
interface SignatureTreeOptions {
    maxLineChars?: number;
}
/**
 * Render symbols as a signatures-only tree for LLM context: per file (sorted by
 * path) a header line, then one line per symbol, with `ELISION_MARKER` between
 * symbols that are not adjacent. Pure; output is independent of input order.
 *
 * A line is the symbol's `attrs.signature`, else `<name> (<kind>)`. Symbols
 * order by `attrs.startLine`, then name, then id. A qualified name
 * (`Job.run`) indents one level per dot. Symbols with no `startLine`
 * (exported types and consts) render after the line-ordered ones, sorted by
 * name then id, and get no elision markers because their position is unknown.
 */
declare function renderSignatureTree(nodes: readonly GraphNode[], options?: SignatureTreeOptions): string;

/**
 * C-74 — deterministic per-file / per-symbol **context dossier** (Class A). A
 * pure projection of the already-computed graph: no LLM, no source re-parse. The
 * command layer (graph-context.ts) loads the snapshot and hands the assembled
 * inputs here; this module owns only the shaping + the markdown render, so it is
 * unit-testable on synthetic graphs.
 */
/** Bumped when the dossier shape changes, so a RAG store can invalidate records. */
declare const SCHEMA_VERSION = "2";
interface Provenance {
    snapshotId: number;
    ref: string;
    commitHash: string | null;
    takenAt: string;
    indexVersion: string;
}
/**
 * Consumers split by declaring-file role (C-74/G3): for core exports most inbound
 * references are test files, which is truthful but low-signal for "what production
 * code depends on this" — so source and test consumers are separated, not flattened.
 */
interface Consumers {
    source: string[];
    test: string[];
    counts: {
        source: number;
        test: number;
        total: number;
    };
    note: string;
}
interface FileOwnership {
    primaryOwner: string;
    busFactor: number;
    authorCount: number;
}
/** One of a file's declared symbols, projected for the dossier. */
interface SymbolLine {
    name: string;
    exported: boolean;
    /** One-line type signature (C-79), when indexed for this declaration. */
    signature?: string;
    cognitive?: number;
    cyclomatic?: number;
    loc?: number;
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
interface SymbolDossier {
    exported: boolean;
    /** G1 slot — the one-line type signature indexed from `attrs.signature` (C-79); null when unannotated or unresolvable. */
    signature: string | null;
    /** G2 slot — leading docstring / intent. Null today. */
    purpose: string | null;
    complexity: {
        cognitive?: number;
        cyclomatic?: number;
    };
    loc?: number;
    utilization: number;
    consumers: Consumers;
    blastRadius: number;
    coupledWith: {
        symbolId: string;
        name: string;
        fileId: string;
        coImports: number;
    }[];
}
interface FileDossier {
    metrics: NodeMetrics;
    churn: {
        windowDays: number;
        value: number;
    } | null;
    centrality: number;
    ownership: FileOwnership | null;
    symbols: SymbolLine[];
    dependsOn: string[];
    consumers: Consumers;
    blastRadius: BlastRadiusEntry[];
}
interface ContextDossier {
    schemaVersion: string;
    target: {
        id: string;
        kind: "file" | "symbol";
        name: string;
        path: string;
        span?: {
            startLine: number;
            endLine: number;
        };
    };
    provenance: Provenance;
    symbol?: SymbolDossier;
    file?: FileDossier;
    notes: string[];
}
interface ContextBuildInput {
    target: GraphNode;
    kind: "file" | "symbol";
    provenance: Provenance;
    /** All nodes for the snapshot, symbols INCLUDED. */
    nodes: readonly GraphNode[];
    /** `references` edges as {srcId=importing file, dstId=symbol id}. */
    refEdges: readonly ReferenceEdgeLite[];
    /** `imports` edges as {srcId, dstId} (file → file/external). */
    importEdges: readonly {
        srcId: string;
        dstId: string;
    }[];
    metrics: ReadonlyMap<string, NodeMetrics>;
    churnByFile: ReadonlyMap<string, number>;
    churnWindowDays: number;
    centrality: ReadonlyMap<string, number>;
    ownership: ReadonlyMap<string, FileOwnership> | null;
    /** File id → node role, for splitting consumers into source vs test (G3). */
    roleByFile: ReadonlyMap<string, string>;
}
declare function buildContextDossier(input: ContextBuildInput): ContextDossier;

/**
 * Human/agent-readable markdown projection of a {@link ContextDossier} (C-74).
 * The JSON form is the RAG-store record; this is the same facts rendered for a
 * reader (or an agent that prefers prose). Deterministic — no LLM.
 */
declare function renderContextMarkdown(d: ContextDossier): string;

/**
 * C-80 — the **context bundle**: one deterministic pull of the complete paired
 * context for a symbol/file, the push half of the ingestion API. It wraps the
 * C-74 dossier with the three things an ingestor needs to embed/answer WITHOUT
 * opening the file: the raw **source chunk** (source text of the span), the
 * resolved **graph linkages as explicit edges** (callers / dependencies /
 * coupled-with — not just counts), and **coverage** (C-63, when the overlay is
 * ingested). No LLM; a pure projection of the graph + the working-tree source.
 */
declare const BUNDLE_SCHEMA_VERSION = "2";
interface SourceChunk {
    /** Repo-relative file id the chunk was read from. */
    path: string;
    /** 1-based inclusive line span for a symbol; null for a whole-file target. */
    span: {
        startLine: number;
        endLine: number;
    } | null;
    /** The source text, or null when the file could not be read. */
    text: string | null;
    note?: string;
}
/** A resolved graph linkage, deterministic and directional relative to the target. */
interface BundleEdge {
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
interface BundleEdges {
    /** Inbound — who references/imports the target. */
    callers: BundleEdge[];
    /** Outbound — what the target references/imports. */
    dependencies: BundleEdge[];
    /** Co-import coupling partners (symbol targets only). */
    coupledWith: BundleEdge[];
    note: string;
}
interface Coverage {
    pct: number | null;
    note?: string;
}
interface ContextBundle {
    schemaVersion: string;
    dossier: ContextDossier;
    source: SourceChunk;
    edges: BundleEdges;
    coverage: Coverage;
}
interface BundleBuildInput {
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
declare function buildContextBundle(input: BundleBuildInput): ContextBundle;
/** Concatenated text projection — hand this straight to an embedder/LLM. */
declare function renderBundleText(bundle: ContextBundle): string;

/**
 * PageRank over one snapshot's file-level graph (symbol nodes and `references`
 * edges excluded, as codewatch's `graph relevant` reads it). Pass
 * `personalization` to seed the walk toward target node ids.
 */
declare function snapshotPageRank(store: CodeGraphStore, snapshotId: number, options?: PageRankOptions): PageRankResult;
/** Relevance of every file-level node to `seedIds`, as codewatch's `graph context` computes it. */
declare function snapshotRelevance(store: CodeGraphStore, snapshotId: number, seedIds: readonly string[], options?: RelevanceOptions): Map<string, number>;
/** The snapshot's `references` edges: importing file to imported symbol. */
declare function snapshotReferenceEdges(store: CodeGraphStore, snapshotId: number): ReferenceEdgeLite[];
/** Per-symbol consumer files for one snapshot. */
declare function snapshotSymbolConsumers(store: CodeGraphStore, snapshotId: number): SymbolConsumers[];
/** Co-import symbol coupling pairs for one snapshot. */
declare function snapshotSymbolCoupling(store: CodeGraphStore, snapshotId: number, options?: SymbolCouplingOptions): SymbolCouplingPair[];

/**
 * The free-function reading surface named in the package API. Each delegates to
 * the store's method of the same name, so a caller that only reads a snapshot
 * never has to hold on to the store's shape.
 */
declare function listNodes(store: CodeGraphStore, snapshotId: number, opts?: {
    includeSymbols?: boolean;
}): GraphNode[];
declare function listEdges(store: CodeGraphStore, snapshotId: number, opts?: {
    includeReferences?: boolean;
}): GraphEdge[];
declare function listMetrics(store: CodeGraphStore, snapshotId: number): GraphMetric[];
declare function listMetricsForNode(store: CodeGraphStore, snapshotId: number, nodeId: string): GraphMetric[];
declare function listEdgesTouching(store: CodeGraphStore, snapshotId: number, nodeId: string, opts?: {
    includeReferences?: boolean;
}): GraphEdge[];
declare function aggregateMetrics(store: CodeGraphStore, snapshotId: number, opts?: {
    name?: string;
}): MetricAggregate[];

/** The `unit` a metric row is stored with; every row of one metric name carries the same unit. */
type MetricUnit = "count" | "lines" | "ratio" | "days" | "percent" | "per100loc";
/** How file values combine into a directory; `none` means no rollup reproduces the group's true value. */
type MetricRollup = "sum" | "max" | "mean" | "none";
/** Which way is worse, for ranking and colouring; `neutral` makes no value judgement. */
type MetricDirection = "higher-worse" | "lower-worse" | "neutral";
/** A missing row reads as zero (a sparse writer's floor) or is left out of means, percentiles, and ranks. */
type MetricAbsence = "zero" | "exclude";
/** The code-graph module that writes the metric, for provenance. */
type MetricSource = "degree" | "source-metrics" | "lcom" | "call-graph" | "exception-handling" | "line-density" | "dead-code" | "growth-risk" | "history" | "test-linker" | "test-kinds" | "coverage";
interface MetricDescriptor {
    /** The stored name, or a template such as `churn_{w}` when {@link windowed} is set. */
    name: string;
    unit: MetricUnit;
    /** Node kinds the writer attaches this metric to. */
    appliesTo: readonly NodeKind[];
    rollup: MetricRollup;
    direction: MetricDirection;
    absent: MetricAbsence;
    source: MetricSource;
    description: string;
    /** Set on templates: `{w}` in `name` and `description` stands for a window such as `30d` or `lifetime`. */
    windowed?: true;
    /** Set on a resolved windowed descriptor: the window its name carries. */
    window?: string;
}

/** Every metric name code-graph writes, with windowed names as `{w}` templates. */
declare const METRIC_CATALOGUE: readonly MetricDescriptor[];

/** The descriptor for a stored metric name, resolving windowed names such as `churn_90d`; null when uncatalogued. */
declare function describeMetric(name: string): MetricDescriptor | null;
/** Descriptors for a set of stored names, in the order given; uncatalogued names are returned separately. */
declare function describeMetrics(names: Iterable<string>): {
    described: MetricDescriptor[];
    unknown: string[];
};

/** The three whole-snapshot reads rule evaluation needs; any store with them can be checked. */
type RuleStore = Pick<CodeGraphStore, "listNodes" | "listEdges" | "listMetrics">;

interface RunChecksOptions {
    snapshotId: number;
    rules: readonly CheckRule[];
    baselineSnapshotId?: number;
}
declare function runChecks(store: CodeGraphStore, options: RunChecksOptions): CheckResult;
/** Every rule's violations in one snapshot with no baseline; needs only the three whole-snapshot reads. */
declare function snapshotViolations(store: RuleStore, snapshotId: number, rules: readonly CheckRule[]): CheckViolation[];

type VerdictLabel = "confirmed" | "justified" | "unclear";
interface VerdictCitation {
    path: string;
    lineStart: number;
    lineEnd: number;
    quote: string;
}
/** A finding as stored against a snapshot, addressed by its `findingKey`. */
interface StoredFinding {
    key: string;
    finding: Finding;
    /** Hash of the excerpt a reader would be shown for this finding; carry-forward compares it. */
    excerptHash?: string;
}
/** A model's judgement of one stored finding, after its citations were verified. */
interface StoredVerdict {
    key: string;
    verdict: VerdictLabel;
    rationale: string;
    citations: VerdictCitation[];
    /** Hash of the excerpt the verdict judged. */
    excerptHash: string;
    model?: string;
    costUsd?: number;
    runId?: string;
    provenance?: string;
    controlRun?: "ok" | "provisional";
    dropped?: string[];
    /** The snapshot this verdict was carried from, when carry-forward copied it. */
    carriedFrom?: number;
}
interface FindingKeyInput {
    finding: Finding;
    /** The innermost symbol node id containing the finding; the finding's path when absent. */
    anchor?: string;
    /** The source text of the flagged lines. */
    flaggedText: string;
    excerptHash?: string;
}
/** Whitespace-insensitive, so reindenting or reflowing the flagged lines keeps the key. */
declare function normalizeFlaggedText(text: string): string;
declare function hashText(text: string): string;
/**
 * A finding's identity across snapshots: no line number, so an inserted line above it
 * keeps the key, and a collision ordinal separates same-rule findings on the same text.
 */
declare function findingKey(input: FindingKeyInput, ordinal?: number): string;
/** Key a whole audit's findings, numbering collisions in source order so the result ignores input order. */
declare function keyFindings(inputs: readonly FindingKeyInput[]): StoredFinding[];
/** Insert or replace findings by key within one snapshot. */
declare function saveFindings(store: CodeGraphStore, snapshotId: number, findings: readonly StoredFinding[]): void;
/** A row whose attrs is not a `Finding` is skipped: `saveFindings` never writes one. */
declare function listFindings(store: CodeGraphStore, snapshotId: number): StoredFinding[];
/** Insert or replace verdicts by key within one snapshot. */
declare function saveVerdicts(store: CodeGraphStore, snapshotId: number, verdicts: readonly StoredVerdict[]): void;
declare function listVerdicts(store: CodeGraphStore, snapshotId: number): StoredVerdict[];
/**
 * Copy each verdict of `from` onto the finding in `to` with the same key whose excerpt hash
 * equals the one the verdict judged. A verdict `to` already holds is kept. Returns the count copied.
 */
declare function carryForwardVerdicts(store: CodeGraphStore, from: number, to: number): number;

/** Glob when the pattern has a `*` (`**` crosses directories, `*` stays in a segment); otherwise a case-sensitive substring. */
declare function patternToRegex(pattern: string): RegExp;
declare function compilePatterns(patterns: readonly string[] | undefined): RegExp[];
declare function matchesAny(value: string, patterns: readonly RegExp[]): boolean;

interface ValidateRulesOptions {
    /** Called with a human-readable message when a deprecated alias is healed. */
    onWarn?: (message: string) => void;
}
declare function validateRules(input: unknown, options?: ValidateRulesOptions): readonly CheckRule[];

declare const DEFAULT_OUTLIER_MIN_SAMPLE = 20;
/** Linear interpolation between closest ranks, the definition numpy and spreadsheets use by default. */
declare function percentileOf(values: readonly number[], percentile: number): number;

/** A snapshot id, or a ref name resolved to that ref's newest snapshot. */
type SnapshotSpec = number | string;
interface CheckSnapshotOptions {
    snapshot: SnapshotSpec;
    rules: readonly CheckRule[];
    baseline?: SnapshotSpec;
}
interface CheckSnapshotResult {
    snapshot: SnapshotRow;
    baselineSnapshot?: SnapshotRow;
    result: CheckResult;
}
declare function resolveSnapshot(store: CodeGraphStore, spec: SnapshotSpec): SnapshotRow;
/** Check one snapshot against a rule set, marking violations already present in the baseline as carryover. */
declare function checkSnapshot(store: CodeGraphStore, options: CheckSnapshotOptions): CheckSnapshotResult;
/** Read and validate a `check.json` rules file; deprecated aliases heal through `onWarn`. */
declare function loadCheckRules(path: string, options?: ValidateRulesOptions): Promise<readonly CheckRule[]>;

interface MetricDelta {
    nodeId: string;
    name: string;
    before: number | null;
    after: number | null;
    delta: number | null;
}
interface NodeRename {
    oldId: string;
    newId: string;
    reason: IdAliasReason;
    node: GraphNode;
}
interface GraphDiffSummary {
    fromSnapshotId: number;
    toSnapshotId: number;
    addedNodes: number;
    removedNodes: number;
    renamedNodes: number;
    unchangedNodes: number;
    addedEdges: number;
    removedEdges: number;
    metricChanges: number;
}
/** Why a symbol present in both snapshots changed; `renamed` alone means its footprint held. */
type FootprintChangeReason = "signature" | "consumers" | "coupling" | "renamed";
interface FootprintChange {
    /** The to-snapshot id; a removed symbol keeps its from-snapshot id. */
    symbolId: string;
    /** The from-snapshot id, set only when it differs from `symbolId`. */
    previousId?: string;
    status: "added" | "removed" | "changed";
    /** Empty for an added or removed symbol. */
    reasons: FootprintChangeReason[];
    /** The declaring file, in the to-snapshot's id space where it still exists there. */
    fileId: string;
}
interface FootprintDiff {
    fromSnapshotId: number;
    toSnapshotId: number;
    /** Sorted by `symbolId`; an unchanged symbol is absent. */
    changes: FootprintChange[];
    /** Sorted distinct declaring files of `changes`; consumer files never appear here. */
    files: string[];
}
interface GraphDiff {
    summary: GraphDiffSummary;
    addedNodes: GraphNode[];
    removedNodes: GraphNode[];
    renamedNodes: NodeRename[];
    addedEdges: GraphEdge[];
    removedEdges: GraphEdge[];
    metricDeltas: MetricDelta[];
}

interface DiffSnapshotsOptions {
    fromSnapshotId: number;
    toSnapshotId: number;
}
/**
 * Structural diff of two snapshots. Ids follow the alias chain between them, across
 * every rename in between, so a move is not a delete plus an add.
 */
declare function diffSnapshots(store: CodeGraphStore, options: DiffSnapshotsOptions): GraphDiff;

interface CheckDiff extends ViolationBuckets {
    fromSnapshotId: number;
    toSnapshotId: number;
    rulesEvaluated: number;
}
interface DiffCheckResultsOptions {
    fromSnapshotId: number;
    toSnapshotId: number;
    rules: readonly CheckRule[];
}
/**
 * Run the rules on both snapshots and bucket each violation as new, resolved, or
 * unchanged, worsened when it moved further past its threshold and improved when it moved
 * back toward it. From-side ids follow the alias chain into the to-snapshot, so a moved
 * file's violations stay unchanged.
 */
declare function diffCheckResults(store: CodeGraphStore, options: DiffCheckResultsOptions): CheckDiff;

/**
 * A symbol's documentable footprint (C-75): structural inputs only, so a moved declaration,
 * a churn window or a centrality shift never reads as a change.
 */
interface FootprintParts {
    /** Hash of `{name, exported, signature, purpose}`; no span. */
    signature: string;
    /** Hash of the sorted distinct file ids that reference the symbol. */
    consumers: string;
    /** Hash of the sorted co-import partner symbol ids at or above `minCoImports`. */
    coupling: string;
}
interface SymbolFootprint {
    symbolId: string;
    parts: FootprintParts;
    /** Hash of the three part hashes. */
    hash: string;
}
interface FootprintGraph {
    nodes: readonly GraphNode[];
    edges: readonly GraphEdge[];
}
interface FootprintOptions {
    /** Drop a referencing file from consumers and co-import coupling, e.g. test files. Default keeps all. */
    ignoreConsumer?: (fileId: string) => boolean;
    /** Co-import threshold for a coupling partner. Default 2. */
    minCoImports?: number;
}
/** A doc target: the default unit is one file holding its symbols. */
interface FootprintUnit {
    unitId: string;
    symbolIds: readonly string[];
}
/** Footprint of every symbol node in the graph, keyed by symbol id. */
declare function computeFootprints(graph: FootprintGraph, options?: FootprintOptions): Map<string, SymbolFootprint>;
/**
 * Order-independent hash of a unit's `[symbolId, footprint.hash]` pairs. A member with no
 * footprint hashes as null, so a symbol that disappears still changes the set.
 */
declare function symbolSetHash(unit: FootprintUnit, footprints: ReadonlyMap<string, SymbolFootprint>): string;

interface DiffFootprintsOptions extends FootprintOptions {
    fromSnapshotId: number;
    toSnapshotId: number;
}
/**
 * Symbols whose documentable footprint differs between two snapshots. From-snapshot ids
 * follow the alias chain first, so a moved file reads as `renamed`, not a remove plus an add.
 */
declare function diffFootprints(store: CodeGraphStore, options: DiffFootprintsOptions): FootprintDiff;

/**
 * What a consumer generated a unit's doc from. Provenance lives with the consumer, not the
 * store, so it survives snapshot prune.
 */
interface UnitProvenance {
    unitId: string;
    /** The to-snapshot's commit hash; null for a working-tree snapshot. */
    commit: string | null;
    symbolSetHash: string;
    /** The generator the consumer used; the gate records it but never calls one. */
    model: string | null;
}
interface UnitProvenanceInput {
    unit: FootprintUnit;
    footprints: ReadonlyMap<string, SymbolFootprint>;
    snapshot: Pick<SnapshotRow, "commitHash">;
    model?: string | null;
}
type RegenerateReason = "new" | "changed";
interface UnitRegeneration {
    unitId: string;
    reason: RegenerateReason;
}
interface GateUnitsInput {
    prior: readonly UnitProvenance[];
    units: readonly FootprintUnit[];
    footprints: ReadonlyMap<string, SymbolFootprint>;
}
/** An empty `regenerate` means the caller makes no LLM call. */
interface GateResult {
    regenerate: UnitRegeneration[];
    skip: string[];
    /** Prior units that no longer exist. */
    orphaned: string[];
}
/** A fresh provenance record for one unit at the given snapshot. */
declare function unitProvenance(input: UnitProvenanceInput): UnitProvenance;
/** Splits units into those whose symbol-set hash moved since the prior record and those that did not. */
declare function gateUnits(input: GateUnitsInput): GateResult;

interface EmbeddableSymbol {
    id: string;
    name: string;
    file: string;
    signature: string;
    purpose?: string;
    text: string;
    textHash: string;
}
interface EmbedCoverage {
    /** Embeddable exported symbols in the snapshot. */
    symbols: number;
    /** How many symbols have a stored vector for this model. */
    embedded: number;
    /** How many carry docstring purpose text (where recall is strongest). */
    withPurpose: number;
}
interface EmbedSnapshotResult extends EmbedCoverage {
    model: string;
    /** Unique new texts sent to the embedder (symbols can share a text). */
    newlyEmbedded: number;
    /** Symbols whose vector was already stored (content-addressed cache hits). */
    reused: number;
}
/** Outcome of the non-fatal indexing pass: a down backend is reported, never thrown. */
type EmbedAttempt = {
    ok: true;
    result: EmbedSnapshotResult;
} | {
    ok: false;
    model: string;
    error: string;
};
interface SimilarCandidate {
    id: string;
    name: string;
    file: string;
    signature: string;
    purpose?: string;
    /** Cosine similarity to the query, in [-1, 1]. */
    score: number;
}
interface SimilarResult {
    query: string;
    model: string;
    coverage: EmbedCoverage;
    candidates: SimilarCandidate[];
}
/** Query prefixes are the embedder's to apply; configure them with its `prefixes` option. */
interface FindSimilarOptions {
    limit?: number;
}

/** Mirrors the gate harness: purpose text is appended to the signature when present. */
declare function buildEmbedText(signature: string, purpose?: string | null): string;
declare function hashEmbedText(text: string): string;
/**
 * The embeddable corpus of a snapshot: exported symbols that carry a signature,
 * excluding test/fixture/generated code (matching the validated gate corpus).
 */
declare function listEmbeddableSymbols(store: CodeGraphStore, snapshotId: number): EmbeddableSymbol[];

/** The blob_cache namespace for symbol vectors; the model column holds `embedder.model`, which names the vector space including its prefixes. */
declare const SYMBOL_EMBEDDING_NAMESPACE = "code-graph/symbol-embedding";
interface CachedEmbedResult {
    /** L2-normalized vectors for every input text, keyed by its text hash. */
    byHash: Map<string, number[]>;
    /** Hashes that had no stored vector and were embedded on this call. */
    newHashes: Set<string>;
}
/**
 * Embed texts through the content-addressed store: only texts whose hash has
 * no vector for this model reach the embedder; new vectors are normalized and
 * persisted batch by batch so the next call (or a retry after a failure) is a cache hit.
 */
declare function embedTextsCached(store: CodeGraphStore, embedder: Embedder, texts: readonly string[]): Promise<CachedEmbedResult>;

/**
 * Precompute capability embeddings for a snapshot. Only texts whose hash has no
 * stored vector are sent to the embedder, so re-runs and unchanged symbols cost
 * nothing: the content-addressed store is the incremental-reuse mechanism.
 */
declare function embedSnapshot(store: CodeGraphStore, snapshotId: number, embedder: Embedder): Promise<EmbedSnapshotResult>;
/**
 * The post-index pass. A backend failure (ollama down, model missing) must not
 * fail the index: the snapshot is already persisted and valid without vectors.
 */
declare function tryEmbedSnapshot(store: CodeGraphStore, snapshotId: number, embedder: Embedder): Promise<EmbedAttempt>;
/**
 * The query-time "about to write X: does it exist?" surface. Embeds the query
 * (an intent sentence, a pseudo-signature, or both as `sig -- intent`), ranks
 * the snapshot's embedded symbols by cosine similarity, and returns the top-K
 * with coverage so the caller can weigh how much of the repo was searchable.
 */
declare function findSimilarCapability(store: CodeGraphStore, snapshotId: number, query: string, embedder: Embedder, opts?: FindSimilarOptions): Promise<SimilarResult>;

/** A text-summarization backend the product injects; `model` keys the stored summaries. */
interface Summarizer {
    readonly model: string;
    summarize(prompt: string): Promise<string>;
}
interface ConventionSymbol {
    name: string;
    signature: string;
    purpose?: string;
}
interface ConventionArea {
    /** Stable over membership: `area-` plus a hash of the member file list. */
    id: string;
    /** Dominant directory of the members. */
    label: string;
    /** Member files, most-connected first. */
    files: string[];
    size: number;
    topSymbols: ConventionSymbol[];
    /** Hash of the summarizer prompt, which is the summary-cache key. */
    contentHash: string;
    summary?: string;
}
interface ConventionCoverage {
    /** Non-generated indexed files in the snapshot. */
    files: number;
    /** Files inside a kept area; the rest are too small or isolated to summarize. */
    grouped: number;
    areas: number;
    summarized: number;
}
interface ConventionMap {
    model: string;
    coverage: ConventionCoverage;
    areas: ConventionArea[];
}
interface SummarizeConventionsResult extends ConventionMap {
    /** Cache misses sent to the summarizer on this call. */
    newlySummarized: number;
    /** Areas whose summary was already stored. */
    reused: number;
}
interface ConventionMatch {
    id: string;
    label: string;
    summary: string;
    files: string[];
    size: number;
    /** Cosine similarity of the query to the area summary, in [-1, 1]. */
    score: number;
}
interface ConventionQueryResult {
    query: string;
    model: string;
    embeddingModel: string;
    coverage: ConventionCoverage;
    matches: ConventionMatch[];
}
/** The cut level: how coarse the partition is and which areas are kept. */
interface ConventionOptions {
    /** Coarse community count to merge down to; default scales with repo size. */
    targetCount?: number;
    /** Areas smaller than this stay ungrouped (not summarized). Default 3. */
    minSize?: number;
}
interface FindConventionsOptions extends ConventionOptions {
    /** Matches returned. Default 3. */
    limit?: number;
}
interface ConventionCorpus {
    areas: ConventionArea[];
    /** Summarizer prompt per area, keyed by the area's `contentHash`. */
    prompts: Map<string, string>;
    coverage: ConventionCoverage;
}

/**
 * Greedy-modularity (Clauset-Newman-Moore) community detection over the
 * undirected file dependency graph. Deterministic: ties and labels resolve
 * by sorted node id, so the same graph always yields the same partition.
 *
 * Two optional controls shape the C-88 capability-altitude cut, in opposite
 * directions: `maxSize` skips any merge that would grow a community past it
 * (greedy CNM otherwise snowballs a dense graph into one giant blob — the
 * cap shapes formation instead of trying to split after the fact), and
 * `targetCount` keeps merging past the natural modularity stop (taking the
 * least-bad allowed merge) while more communities than that remain, so a
 * sparse fragmented graph still coarsens. Disconnected components can never
 * merge, so the floor is the component count.
 */
declare function detectCommunities(fileIds: readonly string[], edges: readonly GraphEdge[], opts?: {
    targetCount?: number;
    maxSize?: number;
}): Map<string, string[]>;

/** Coarse capability-altitude cut: about one area per 25 files, clamped to 6..40. */
declare function defaultTargetCount(fileCount: number): number;
/**
 * The deterministic half of the convention layer: partition the barrel-resolved
 * file graph into coarse areas and build each area's summarizer prompt and cache key.
 */
declare function buildConventionAreas(store: CodeGraphStore, snapshotId: number, opts?: ConventionOptions): ConventionCorpus;

/** The blob_cache namespace for area summaries; the model column holds `summarizer.model`. */
declare const COMMUNITY_SUMMARY_NAMESPACE = "code-graph/community-summary";
/**
 * Generate or reuse the summary of every area. Only cache misses reach the
 * summarizer, so cost scales with what structurally changed, not with repo size.
 */
declare function summarizeConventions(store: CodeGraphStore, snapshotId: number, summarizer: Summarizer, opts?: ConventionOptions): Promise<SummarizeConventionsResult>;
/** Read-only view: the partition plus whatever summaries are already stored. Never calls a summarizer. */
declare function getConventionMap(store: CodeGraphStore, snapshotId: number, model: string, opts?: ConventionOptions): ConventionMap;

/**
 * "How does this repo do X?": rank summarized areas by similarity of their
 * summary to the question. Returns candidates, not verdicts. Summary vectors
 * share the content-addressed embedding cache with the symbol layer.
 */
declare function findConventions(store: CodeGraphStore, snapshotId: number, query: string, embedder: Embedder, model: string, opts?: FindConventionsOptions): Promise<ConventionQueryResult>;

export { ALIAS_BASE_ATTR, ALL_ROLES, type AliasChain, type AliasChainInput, type AliasChainOptions, type AliasLoader, type AliasResolution, type AnnotateRolesOptions, type AssembledIndexerMetrics, BUNDLE_SCHEMA_VERSION, BlastRadiusEntry, type BodyDeletePlan, type BodyDeleteSkip, type BodyDeleteTarget, type BundleBuildInput, type BundleEdge, type BundleEdges, COMMUNITY_SUMMARY_NAMESPACE, SCHEMA_VERSION as CONTEXT_SCHEMA_VERSION, COVERAGE_METRIC_NAME, type CachedEmbedResult, type CallPathOptions, type CheckDiff, CheckResult, CheckRule, type CheckSnapshotOptions, type CheckSnapshotResult, CheckViolation, CodeGraphStore, type Consumers, type ContextBuildInput, type ContextBundle, type ContextDossier, type ConventionArea, type ConventionCorpus, type ConventionCoverage, type ConventionMap, type ConventionMatch, type ConventionOptions, type ConventionQueryResult, type ConventionSymbol, type Coverage, DEAD_CODE_METRIC_NAMES, DEFAULT_ACCRETION_WINDOWS, DEFAULT_CHURN_WINDOWS, DEFAULT_MAX_LINE_CHARS, DEFAULT_OUTLIER_MIN_SAMPLE, DELETION_CANDIDATE_SIGNAL, DOMAIN_DDL, type DeepAst, type DeepAstInput, type DiffCheckResultsOptions, type DiffFootprintsOptions, type DiffSnapshotsOptions, ELISION_MARKER, EXCEPTION_METRIC_NAMES, EdgeKind, type EmbedAttempt, type EmbedCoverage, type EmbedSnapshotResult, type EmbeddableSymbol, type ExternalDiagnostic, type ExtremeFindingsInput, type ExtremeMutationOptions, type ExtremeMutationResult, type ExtremeSummary, FINDING_DDL, type FileDossier, FileFingerprint, type FileOwnership, type FindConventionsOptions, type FindSimilarOptions, type Finding, type FindingKeyInput, type FootprintChange, type FootprintChangeReason, type FootprintDiff, type FootprintGraph, type FootprintOptions, type FootprintParts, type FootprintUnit, GROWTH_RISK_METRIC_NAMES, type GateResult, type GateUnitsInput, type GraphDiff, type GraphDiffSummary, GraphEdge, GraphFragment, GraphMetric, GraphNode, type HistoryMetricsOptions, INDEX_VERSION, IdAlias, IdAliasReason, type IndexOptions, type IndexResult, type IndexSource, type IstanbulCoverage, KIT, LanguageExtractor, type LanguageExtractorOptions, type LevelEdge, type LineSpan, type Lineage, type LineageSnapshot, type LineageStep, type LoadedHistory, MAX_BODY_DELETES, METRIC_CATALOGUE, MIGRATIONS, type MemberInfo, type MetricAbsence, type MetricAggregate, type MetricDelta, type MetricDescriptor, type MetricDirection, type MetricRollup, type MetricSource, type MetricUnit, type MinifiedSource, type MinifyLanguage, NO_PROTOCOL_SOURCE, NodeKind, NodeMetrics, type NodeRename, NodeRole, PSEUDO_TESTED_SIGNAL, type PageRankOptions, type PageRankResult, type PageRankRow, type ParamInfo, type PlanBodyDeletesInput, type PriorSnapshotOptions, type ProjectedHop, type ProtocolDiagnostic, type ProtocolEdge, type ProtocolEdgeResult, type ProtocolEndpoint, type ProtocolKind, type ProtocolSourceFile, type Provenance, type PruneOptions, type PrunePlan, type PruneResult, PythonGraphExtractor, type ReadFile, ReferenceEdgeLite, type RegenerateReason, type RelevanceOptions, type ResolveAliasOptions, type ReuseBasis, type RoleGlobs, type RoleHints, type RuleStore, type RunChecksOptions, SCHEMA_VERSION$1 as SCHEMA_VERSION, SNAPSHOT_SCOPED_TABLES, SOURCE_METRIC_NAMES, SYMBOL_EMBEDDING_NAMESPACE, SYMBOL_ID_SEP, SYMBOL_METRIC_NAMES, Severity, type SignatureTreeOptions, type SimilarCandidate, type SimilarResult, type SnapshotInsert, SnapshotRow, type SnapshotSpec, type SourceChunk, type SourceLanguage, type StoredFinding, type StoredVerdict, type SummarizeConventionsResult, type Summarizer, SymbolConsumers, SymbolCouplingOptions, SymbolCouplingPair, type SymbolDossier, type SymbolFootprint, type SymbolLine, type SymbolSpan, TRUNCATION_SUFFIX, type TestCoverageOwnershipOptions, TestSourceLink, type TopMetricRow, TsMorphGraphExtractor, type TsMorphGraphExtractorOptions, UNIMPORTED_ROLES, type UnitProvenance, type UnitProvenanceInput, type UnitRegeneration, type ValidateRulesOptions, type VerdictCitation, type VerdictLabel, ViolationBuckets, aggregateMetrics, aliasChain, annotateRoles, assembleIndexerMetrics, attributeCoverage, buildAliases, buildContextBundle, buildContextDossier, buildConventionAreas, buildEmbedText, buildFileModuleNodes, buildIndexerMetrics, buildLineage, canonicalEdgeKind, canonicalMetricName, canonicalRole, carryForwardVerdicts, checkSnapshot, classifyRole, collectDeclaredNames, collectDeclaredSpans, compilePatterns, computeDeadCodeMetrics, computeDeepAst, computeFootprints, computeGrowthRiskMetrics, computeMetrics, computePageRank, computeRecencyWindows, computeRelevance, computeRoleHints, computeSourceMetrics, computeTestCoverageOwnership, coveredFunctionStarts, createAliasChain, defaultTargetCount, describeMetric, describeMetrics, detectCommunities, detectGitHead, detectRenames, diffCheckResults, diffFootprints, diffSnapshots, edgeWeight, embedSnapshot, embedTextsCached, externalId, externalToFinding, extractProtocolEdges, extremeFindings, fileId, findCallPath, findConventions, findSimilarCapability, findingKey, gateUnits, getConventionMap, getEdgeWeight, gitTreeSource, hashContent, hashEmbedText, hashText, importMarker, indexPaths, isGeneratedByHeuristic, isGeneratedFile, isInsideGitRepo, isMinifyLanguage, keyFindings, lineagePath, listEdges, listEdgesTouching, listEmbeddableSymbols, listFindings, listMetrics, listMetricsForNode, listNodes, listVerdicts, loadCheckRules, loadGeneratedPatterns, loadHistoryMetrics, loadLineage, loadRoleGlobs, matchesAny, minifySource, moduleId, normalizeFlaggedText, openCodeGraph, originalLine, packageId, parentModuleId, parseSymbolId, patternToRegex, percentileOf, planBodyDeletes, planPrune, priorSnapshotForRef, projectCallPath, pruneDanglingReferences, readSourceFiles, renderBundleText, renderContextMarkdown, renderSignatureTree, resolveAlias, resolveBarrelEdges, resolveChurnWindows, resolveGitRef, resolveSnapshot, runChecks, runExtremeMutation, runPrune, saveFindings, saveVerdicts, snapshotCallPath, snapshotPageRank, snapshotReferenceEdges, snapshotRelevance, snapshotSymbolConsumers, snapshotSymbolCoupling, snapshotViolations, structuralSignature, summarizeConventions, symbolId, symbolSetHash, toFindings, tryEmbedSnapshot, unitProvenance, validateRules, walkSourceFiles, windowSuffix, workingTreeSource };

// ./dist/browser.d.ts
import { a as ChurnWindow, c as CoEditPair } from './change-coupling.js';

declare const NODE_KINDS: readonly ["package", "module", "file", "symbol", "external"];
type NodeKind = (typeof NODE_KINDS)[number];
type EdgeKind = "imports" | "re-exports" | "calls" | "extends" | "implements" | "references" | "depends-on";
/** `requalify` maps a bare-name symbol id from before index version 0.14.0 to its scope-qualified successor. */
type IdAliasReason = "rename" | "move" | "merge" | "requalify";
declare const NODE_ROLES: readonly ["test", "fixture", "story", "lab", "barrel", "types", "config", "script", "entry", "generated", "source"];
type NodeRole = (typeof NODE_ROLES)[number];
interface GraphNode {
    id: string;
    kind: NodeKind;
    name: string;
    parentId?: string;
    language?: string;
    role?: NodeRole;
    attrs?: Record<string, unknown>;
}
interface GraphEdge {
    srcId: string;
    dstId: string;
    kind: EdgeKind;
    attrs?: Record<string, unknown>;
}
interface GraphMetric {
    nodeId: string;
    name: string;
    value: number | null;
    unit?: string;
}
interface GraphFragment {
    nodes: GraphNode[];
    edges: GraphEdge[];
}
interface SnapshotRow {
    id: number;
    ref: string;
    commitHash: string | null;
    takenAt: string;
    indexVersion: string;
    attrs: Record<string, unknown>;
}
interface IdAlias {
    oldId: string;
    newId: string;
    reason: IdAliasReason;
}
interface FileFingerprint {
    fileId: string;
    contentHash: string;
    /**
     * Comment/whitespace-insensitive parse-structure hash (C-18). Absent on
     * snapshots written before C-18 (they can only reuse whole unchanged files).
     */
    structuralHash?: string;
}

interface PackageRoot {
    /** Path relative to repo root, posix-separated (e.g., "packages/cli"). Empty for repo-root package. */
    id: string;
    /** Display name from package.json or directory basename. */
    name: string;
}
/**
 * For each file id, find the longest matching package prefix.
 * Returns a Map from package id → file ids assigned to it.
 * Files matching no package are returned under the empty-string key.
 */
declare function bucketFilesByPackage(fileIds: readonly string[], packages: readonly PackageRoot[]): Map<string, string[]>;

/** One weighted dependency between two nodes of the same package. */
interface WeightedLink {
    src: string;
    dst: string;
    weight: number;
}
/** SCBench's dependency-graph measures over one package's call graph. Every ratio is 0 when its denominator is. */
interface CallGraphMetrics {
    nodes: number;
    edges: number;
    /** `cyclic_dependency_mass`: the share of call weight on edges inside a strongly connected component of two or more callables. */
    cyclicDependencyMass: number;
    /** `propagation_cost`: ordered pairs (a, b), a ≠ b, where b is reachable from a, over n(n − 1). */
    propagationCost: number;
    /** `dependency_entropy`: the mean over callables of the Shannon entropy of out-edge weights, normalized by log(out-degree); 0 at out-degree ≤ 1. */
    dependencyEntropy: number;
}
/**
 * Cyclic mass over a package's file imports, split by what closes the cycle. Both share one
 * denominator, all import weight, so they sum to the cyclic mass of the whole import graph.
 */
interface ImportCyclicMass {
    /** Weight of value imports inside cycles that value imports alone close. */
    value: number;
    /** The rest of the cyclic weight: cycles, or parts of them, that only type-only imports close. */
    typeOnly: number;
}
interface PackageDependencyRow {
    /** The {@link PackageRoot.id}; `""` for nodes under no package. */
    packageId: string;
    calls: CallGraphMetrics;
    imports: ImportCyclicMass;
}
/** CY, PC and ENT over one graph, ignoring links to unlisted nodes; parallel links should already be merged into one weight. */
declare function callGraphMetrics(nodeIds: readonly string[], allLinks: readonly WeightedLink[]): CallGraphMetrics;
/** {@link ImportCyclicMass} over file imports between listed files, `typeOnly` marking the links that carry only types. */
declare function importCyclicMass(fileIds: readonly string[], allLinks: readonly (WeightedLink & {
    typeOnly: boolean;
})[]): ImportCyclicMass;
/**
 * The SCBench dependency-graph measures per package: CY, PC and ENT over `calls` between the
 * symbol nodes given, and cyclic import mass between the file nodes given. Only edges whose
 * ends are both given, of the right kind and in one package count, so a call made at module
 * level, which the extractors attribute to the file, is left out. PC costs O(n·(n + e)) per package, so there is
 * deliberately no whole-tree row.
 */
declare function dependencyGraphMetrics(nodes: readonly GraphNode[], edges: readonly GraphEdge[], packages: readonly PackageRoot[]): PackageDependencyRow[];

interface ReportContext {
    nodes: readonly GraphNode[];
    nodeById: Map<string, GraphNode>;
    metricsByName: Map<string, Map<string, number>>;
    excluders: readonly RegExp[];
    excludedRoles: ReadonlySet<string>;
    windowDays: ChurnWindow;
    /** Metric-name suffix for {@link windowDays} (`30d` … or `lifetime`). */
    windowSuffix: string;
}
interface ReportContextInput {
    nodes: readonly GraphNode[];
    metrics: readonly GraphMetric[];
    excluders: readonly RegExp[];
    excludedRoles: ReadonlySet<string>;
    windowDays: ChurnWindow;
}
declare function buildReportContext(input: ReportContextInput): ReportContext;
declare function keepNode(ctx: ReportContext, nodeId: string): boolean;
declare function lookupMetric(ctx: ReportContext, name: string, nodeId: string): number | undefined;
/**
 * Files ranked by hotspot score: change frequency × complexity, the idea from
 * Adam Tornhill's "Your Code as a Crime Scene" and CodeScene. High scores mark
 * where change and complexity meet, a good place to look first.
 */
declare function topHotspots(ctx: ReportContext, limit: number): HotspotRow[];
declare function hotspotScoreOf(ctx: ReportContext, nodeId: string): number;
/** The complexity factor a file's hotspot score multiplies, read even when the file has no churn; undefined when unmeasured. */
declare function hotspotComplexityOf(ctx: ReportContext, nodeId: string): number | undefined;
declare function busFactorOf(ctx: ReportContext, nodeId: string): number | undefined;
declare function topBusFactorRisks(ctx: ReportContext, limit: number): BusFactorRow[];
/**
 * Sources whose *test coverage* is a single-author silo (test bus factor = 1)
 * — the honest, role-split view: production code can be well-spread while the
 * tests that guard it are owned by one person (or vice versa).
 */
declare function topTestCoverageRisks(ctx: ReportContext, limit: number): TestCoverageRow[];
declare function topCentralFiles(nodes: readonly GraphNode[], edges: readonly GraphEdge[], ctx: ReportContext, limit: number): CentralRow[];

/** SCBench's `cc_high_count` cut: a callable above it counts toward erosion. */
declare const HIGH_CC = 10;
/** SCBench's `cc_extreme_count` cut. */
declare const EXTREME_CC = 30;
/** One measured function: its declaring file, both complexities and its source lines. */
interface CallableComplexity {
    fileId: string;
    cyclomatic: number;
    cognitive: number;
    /** Non-blank, non-comment lines of the body; docstrings, the signature and a lone closing brace are not counted. */
    sloc: number;
}
/**
 * SCBench's complexity summary over a set of callables; the SCBench key each field ports
 * is named on it. Every ratio is 0 when its denominator is.
 */
interface ComplexityDistribution {
    callables: number;
    /** Σ CC·√SLOC over every callable. */
    mass: number;
    /** `mass.high_cc_pct`: the share of {@link mass} in callables with CC above {@link HIGH_CC}. */
    erosion: number;
    /** Σ cognitive·√SLOC over every callable. */
    cogMass: number;
    /** `cog_erosion`: the share of {@link cogMass} in callables with cognitive above {@link HIGH_CC}. */
    cogErosion: number;
    /** `cc_max`. */
    ccMax: number;
    /** `cc_mean`. */
    ccMean: number;
    /** `cc_std`, the population standard deviation. */
    ccStd: number;
    /** `cc_high_count`: callables with CC above {@link HIGH_CC}. */
    ccHighCount: number;
    /** `cc_extreme_count`: callables with CC above {@link EXTREME_CC}. */
    ccExtremeCount: number;
    /** `high_cc_mean`: the mean CC of the callables {@link ccHighCount} counts. */
    highCcMean: number;
    /** `cc_concentration`: the Gini coefficient of CC across callables, 0 when spread evenly. */
    ccGini: number;
}
interface PackageComplexityRow extends ComplexityDistribution {
    /** The {@link PackageRoot.id}; `""` for files under no package. */
    packageId: string;
}
interface ComplexityRollup {
    /** Every callable at once, the figure scb-check reports for a whole tree. */
    total: ComplexityDistribution;
    /** One row per package with a callable, ordered by package id. */
    packages: PackageComplexityRow[];
}
/** The report's `quality` section. */
interface QualitySection {
    /** SCBench erosion and the CC distribution, over named functions in kept files. */
    complexity: ComplexityRollup;
    /** SCBench CY, PC and ENT over each package's calls, and its cyclic import mass split value and type-only. */
    dependencies: PackageDependencyRow[];
}
/** SCBench's complexity measures over `callables`, whatever unit they were gathered from. */
declare function summarizeComplexity(callables: readonly CallableComplexity[]): ComplexityDistribution;
/** {@link summarizeComplexity} for the whole set and for each package's share of it. */
declare function complexityDistribution(callables: readonly CallableComplexity[], packages: readonly PackageRoot[]): ComplexityRollup;
/**
 * The SCBench rollups for the report's `quality` section. Symbols stand in for SCBench's
 * callables, so a function with no symbol node of its own (a nested closure, an unexported
 * helper the extractor does not name) is not counted. The same callables are the call graph's
 * nodes, and kept files the import graph's.
 */
declare function qualitySection(nodes: readonly GraphNode[], ctx: ReportContext, packages: readonly PackageRoot[], edges: readonly GraphEdge[]): QualitySection;

interface HotspotRow {
    nodeId: string;
    churn: number;
    complexity: number;
    /** Shown beside complexity: complexity alone mostly restates file size. */
    loc: number;
    score: number;
    /** Age-recency factor applied to the score (1 = no discount); see recency_{window}d. */
    recency: number;
}
interface NewHotspot extends HotspotRow {
    /**
     * Baseline hotspot score if the file existed in the baseline snapshot;
     * `undefined` ⇒ a newborn file (didn't exist at baseline). Lets the UI split
     * "new file" (neutral) from "existing file that climbed into the ranking".
     */
    before?: number;
}
interface BusFactorRow {
    nodeId: string;
    busFactor: number;
    topAuthorShare: number;
    churn: number;
}
interface CouplingRow {
    fileA: string;
    fileB: string;
    count: number;
}
interface CentralRow {
    nodeId: string;
    score: number;
}
interface UnusedExportRow {
    /** The `symbol` node id (`<fileId>#<name>`). */
    nodeId: string;
    /** The exported name with no inbound reference. */
    name: string;
    /** The file that declares it. */
    fileId: string;
    /** The export's own cognitive complexity (C-58); 0 for a class/type/re-export. */
    cognitive: number;
    /** The export's own LOC, shown beside its cognitive complexity; 0 when unmeasured. */
    loc: number;
    /**
     * The declaring file is re-exported by a `barrel` — so this export is part of a
     * package's public surface and may be consumed *externally* (lower confidence
     * that it's removable). `false` ⇒ internal, no reference found anywhere
     * (higher confidence).
     */
    publicApi: boolean;
}
interface DeadModuleRow {
    /** The unreferenced file's node id. */
    nodeId: string;
    /** Its size, for ranking (a large dead file is the most worth removing). */
    loc: number;
    /** Its role (usually "source" or "types"). */
    role: string;
    /**
     * Public view only: the non-product role whose files still reach this one ("dead in the
     * product, alive in Storybook"). Absent when nothing reaches it. Lab beats story beats test
     * when several do, because tests accompany almost any code and say least about why it exists.
     */
    reachableOnlyFrom?: DeadModuleConsumer;
}
/** Importer roles the public dead-modules view does not count as the product. */
type DeadModuleConsumer = "test" | "story" | "lab";
/**
 * `"all-consumers"` seeds reachability from every unimported role, barrels and `main.*`.
 * `"public"` seeds only from entry, barrel, config, script and `main.*` files.
 */
type DeadModuleView = "all-consumers" | "public";
interface DeadModulesOptions {
    /** Defaults to `"all-consumers"`. */
    view?: DeadModuleView;
}
interface GrowthRiskRow {
    nodeId: string;
    /** Max lexical loop-nesting depth (C-66); 0 when the file's smell is not nesting. */
    loopDepth: number;
    /** Human-readable scaling smells (deep loops, recursion, linear-search-in-loop). */
    smells: string[];
}
interface UntestedRiskRow {
    nodeId: string;
    /** Coverage % from an ingested Istanbul report (C-63). */
    coverage: number;
    /** Hotspot score (churn × complexity × recency) for context. */
    hotspot: number;
    /** hotspot × (1 − coverage/100): a load-bearing, complex, frequently changed file with little test coverage. */
    score: number;
}
interface TestCoverageRow {
    /** Source (non-test) file whose test coverage is owner-concentrated. */
    nodeId: string;
    /** Bus factor of the linked test files' authorship (1 = single owner). */
    testBusFactor: number;
    /** Share of test churn from the single largest test author (0..1). */
    testTopAuthorShare: number;
    /** How many distinct test files link to this source. */
    linkedTests: number;
}
interface GraphReportResult {
    snapshot: SnapshotRow;
    /** The resolved churn window these sections were computed for (`"lifetime"` = all-time). */
    windowDays: ChurnWindow;
    hotspots: HotspotRow[];
    busFactorRisks: BusFactorRow[];
    testCoverageRisks: TestCoverageRow[];
    couplingClusters: CouplingRow[];
    centralFiles: CentralRow[];
    /** Exported symbols with zero inbound references — "no reference found" (C-65). */
    unusedExports: UnusedExportRow[];
    /** Files unreachable from entry roots (barrels/tests/scripts) — "no importer found" (C-65). */
    deadModules: DeadModuleRow[];
    /** Files with structural scaling smells (deep loop nesting) — heuristic, not Big-O (C-66). */
    growthRisks: GrowthRiskRow[];
    /** Load-bearing + complex + churning + under-tested files (C-63); empty if no coverage ingested. */
    untestedRisks: UntestedRiskRow[];
    /** True when no file has churn > 0 in the window (churn sections all empty). */
    emptyWindow?: boolean;
    /** User-facing guidance shown when emptyWindow is true. */
    hint?: string;
    drift?: ReportDrift;
    /** SCBench-aligned code-quality rollups; absent from reports that did not compute them. */
    quality?: QualitySection;
}
interface HotspotDelta {
    nodeId: string;
    before: number;
    after: number;
    delta: number;
}
interface BusFactorChange {
    nodeId: string;
    churn: number;
}
interface CouplingDelta {
    fileA: string;
    fileB: string;
    before: number;
    after: number;
}
interface ReportDrift {
    baselineSnapshot: SnapshotRow;
    newHotspots: NewHotspot[];
    /** Was in baseline top-N, score actually went down (or file gone). */
    resolvedHotspots: HotspotDelta[];
    /** Was in baseline top-N, score didn't improve — newer hotspots displaced it. */
    displacedHotspots: HotspotDelta[];
    worsenedHotspots: HotspotDelta[];
    improvedHotspots: HotspotDelta[];
    newSilos: BusFactorChange[];
    /** Was silo (bus_factor=1) in baseline, now bus_factor>1 or no churn in window. */
    resolvedSilos: BusFactorChange[];
    /** Still bus_factor=1, but churn dropped below top-N (still single-owner). */
    displacedSilos: BusFactorChange[];
    newCoupling: CouplingRow[];
    intensifiedCoupling: CouplingDelta[];
}

/**
 * The set of files re-exported by a `barrel`-role node (1-hop `re-exports`
 * edges) — i.e. files whose exports form a package's public surface. An unused
 * export declared in one of these may still be consumed *externally* (by an npm
 * consumer of a published package), so it's flagged lower-confidence rather than
 * excluded. Transitive barrel chains are not followed (v1); a symbol behind two
 * barrels reads as internal.
 */
declare function publicApiFiles(nodes: readonly GraphNode[], edges: readonly GraphEdge[]): Set<string>;
/**
 * Exported symbols (C-64 `attrs.exported`) with zero inbound `references` — an
 * export that nothing imports by name (utilization is barrel-resolved, C-53, so
 * an export used *through* a barrel reads > 0). Framed as "no reference found",
 * not "dead": it may be used only internally within its own file, or consumed
 * externally if the repo is a published library — hence the `publicApi` split.
 * Ranked by the export's own cognitive complexity (a complex unused export is
 * the most worth removing), scoped to kept (non-excluded) files.
 */
declare function topUnusedExports(symbolNodes: readonly GraphNode[], publicApi: ReadonlySet<string>, ctx: ReportContext, limit: number): UnusedExportRow[];

/**
 * Files unreachable from the entry roots by a forward BFS over `imports` /
 * `re-exports` edges — "no importer found given configured entry points" (C-65),
 * NOT proven dead. Catches transitively-dead chains, not just fan-in-0 files.
 * Blind spots (disclosed): a computed dynamic `import(variable)`, DI/registry
 * strings, and any package entry that isn't an index barrel escape the roots and
 * could make a live file look dead — so treat it as a lead, not a verdict.
 * Ranked by LOC (a large unreferenced file is the most worth removing).
 *
 * The `"public"` view (C-155) drops test, story and lab from the seeds and tags a
 * row those still reach with `reachableOnlyFrom`.
 */
declare function topDeadModules(nodes: readonly GraphNode[], edges: readonly GraphEdge[], ctx: ReportContext, limit: number, options?: DeadModulesOptions): DeadModuleRow[];

/**
 * Files carrying a structural scaling smell (C-66): deep loop nesting, direct
 * recursion, or a linear-scan method call inside a loop. A HEURISTIC, not Big-O:
 * depth-2 loops over two different collections are linear, `.includes` on a `Set`
 * is O(1), and recursion may be well-bounded. Ranked by loop depth, then smell
 * count.
 */
declare function topGrowthRisks(ctx: ReportContext, limit: number): GrowthRiskRow[];

/**
 * Files that are load-bearing, complex, frequently changed and under-tested (C-63),
 * ranked by `hotspot × (1 − coverage/100)`. Requires an
 * ingested coverage overlay (`graph coverage`); with no coverage, the section is
 * empty (never a stale or assumed number — coverage is an overlay, not inferred).
 * A fully-covered hotspot (coverage 100) scores 0 and drops out.
 */
declare function topUntestedRisks(ctx: ReportContext, limit: number): UntestedRiskRow[];

interface ComputeDriftInput {
    baselineSnapshot: SnapshotRow;
    currentHotspots: readonly HotspotRow[];
    baselineHotspots: readonly HotspotRow[];
    /** Current churn × complexity for any nodeId. 0 when file is gone or no longer has churn/complexity. */
    currentHotspotScore: (nodeId: string) => number;
    /**
     * Baseline churn × complexity for a file that existed at baseline, or
     * `undefined` when the file is newborn (absent from the baseline snapshot).
     * Distinguishes a brand-new hotspot from an existing file that climbed in.
     */
    baselineHotspotScore?: (nodeId: string) => number | undefined;
    currentSilos: readonly BusFactorRow[];
    baselineSilos: readonly BusFactorRow[];
    /** Current bus_factor for any nodeId. undefined when file has no churn in window. */
    currentBusFactor: (nodeId: string) => number | undefined;
    currentCoupling: readonly CouplingRow[];
    baselineCoupling: readonly CouplingRow[];
}
declare function computeReportDrift(input: ComputeDriftInput): ReportDrift;

/**
 * Composite dashboard health score. Extracted from dashboard-payload.ts (which
 * sits over the max-file-loc budget) so that file stays lean as new payload
 * slices land.
 */
type HealthComponentKey = "hotspots" | "findings" | "complexity" | "hidden-coupling";
interface HealthComponent {
    key: HealthComponentKey;
    label: string;
    penalty: number;
    /** The most this component can take off the score. */
    cap: number;
    detail: string;
}
/** Points per counted item, and the most one component can take. */
interface PenaltyWeight {
    each: number;
    cap: number;
}
interface HealthWeights {
    hotspots: PenaltyWeight;
    findings: {
        eachNew: number;
        eachCarry: number;
        cap: number;
    };
    /** `each` point per unit of max complexity over `budget`. */
    complexity: PenaltyWeight & {
        budget: number;
    };
    hiddenCoupling: PenaltyWeight;
}
declare const DEFAULT_HEALTH_WEIGHTS: HealthWeights;
interface HealthInput {
    scary: number;
    newViolations: number;
    carryViolations: number;
    maxComplexity: number;
    hiddenCoupling: number;
    /** The hotspot score `scary` counted files at; only the detail text reads it. */
    scaryCutoff?: number;
}
/**
 * Composite health as a transparent sum of independent penalty components, so
 * the UI can show *why* the score is what it is instead of a black-box number.
 * Each component is capped and drawn from a distinct dimension — the hotspots
 * component owns the files over the hotspot cutoff, so the violations component excludes the
 * scary-hotspots rule (no double-count). Ownership (knowledge-silo / bus-factor)
 * signal is deliberately NOT a health component: it saturates on single-author
 * repos and lives on the Ownership tab, not in the cross-cutting score.
 * `weights` defaults to the dashboard's; a caller may weigh the components its own way.
 */
declare function computeHealth(x: HealthInput, weights?: HealthWeights): {
    health: number;
    healthBreakdown: HealthComponent[];
};

/**
 * Per-file structural metrics for the dashboard Dossier heat readout. Extracted
 * from dashboard-payload so that file stays under the max-file-loc budget.
 */
interface NodeMetrics {
    loc?: number;
    cognitiveMax?: number;
    cyclomaticMax?: number;
    maxNesting?: number;
    fanIn?: number;
    fanOut?: number;
    utilization?: number;
    /** Distinct test files linking to this source (C-4); shown in the Dossier (C-59). */
    linkedTests?: number;
    /** Node role (e.g. "barrel") — lets the Dossier explain barrel-resolved utilization. */
    role?: string;
}
/** Fold the flat metric rows into a per-node structural-metrics map. */
declare function collectNodeMetrics(rows: {
    nodeId: string;
    name: string;
    value: number | null;
}[]): Map<string, NodeMetrics>;
/** Every file the Dossier can open on (referenced in hotspots / silos / coupling / coverage / central / drift). */
declare function referencedNodes(report: GraphReportResult): Set<string>;
/**
 * Structural metrics for every file the Dossier can open on. Scoped to
 * referenced nodes rather than the whole graph to keep the payload tight — the
 * Dossier never opens on an unreferenced file.
 */
declare function buildNodeMetrics(report: GraphReportResult, metrics: ReadonlyMap<string, NodeMetrics>): Record<string, NodeMetrics>;
/**
 * Reading-order centrality (top-N central files) PLUS the centrality of every
 * node referenced elsewhere in the payload (hotspots, silos, coupling), so the
 * Dossier can always show a PageRank score instead of "—" for a hotspot that
 * falls outside the top-N central list. Sorted descending, so the Overview
 * "reading order" (top-6 slice) is unaffected.
 */
declare function buildCentralFiles(report: GraphReportResult, centrality: ReadonlyMap<string, number>): {
    nodeId: string;
    score: number;
}[];
/** One declared symbol's utilization (C-53), tagged with its declaring file. */
interface SymbolUtil {
    symbolId: string;
    name: string;
    fileId: string;
    utilization: number;
    /** Whether the symbol is exported (model B, C-64); internal helpers are false. */
    exported: boolean;
}
/**
 * Pair each `symbol` node with its utilization metric and declaring file (C-53).
 * Model B (C-64) adds non-exported function/class nodes; the `exported` attr
 * (defaulting true for pre-C-64 nodes that lack it) lets the Dossier separate a
 * file's public surface from its internal helpers.
 */
declare function collectSymbolUtil(nodes: readonly {
    id: string;
    kind: string;
    name: string;
    parentId?: string;
    attrs?: Record<string, unknown>;
}[], metrics: ReadonlyMap<string, NodeMetrics>): SymbolUtil[];
interface HotExport {
    name: string;
    utilization: number;
    /** The symbol's OWN cognitive complexity (C-58); undefined for a class/type/re-export. */
    cognitive?: number;
    /** Distinct files that reference this export (inbound `references` edges, C-59). */
    consumers: number;
    /** Exported (public surface) vs internal helper (model B, C-64). */
    exported: boolean;
}
/**
 * Per-file symbol detail for the Dossier (C-59, C-64): each of a file's declared
 * symbols with its per-symbol complexity (C-58), utilization (C-53), and
 * consumer count (inbound references). Keeps zero-utilization symbols — a complex
 * but unused symbol is worth seeing. Model B (C-64) adds internal helpers, so the
 * two surfaces are ranked and capped *separately* (the Dossier renders them in
 * their own sections): exports by utilization-then-complexity, internal functions
 * by complexity — otherwise a large public surface would slice every internal
 * helper out before it could show. Scoped to Dossier-openable files; top 8 each.
 */
declare function buildHotExports(symbols: readonly SymbolUtil[], referenced: ReadonlySet<string>, metrics: ReadonlyMap<string, NodeMetrics>, consumersBySymbol: ReadonlyMap<string, number>): Record<string, HotExport[]>;
interface BlastRadiusEntry {
    symbolId: string;
    name: string;
    fileId: string;
    utilization: number;
    complexity: number;
    /** The export's own LOC, shown beside complexity; absent when unmeasured. */
    loc?: number;
    churn: number;
    score: number;
}
/**
 * Rank exports by blast radius = utilization × cognitive complexity × file
 * churn (C-53, "idea d"). An attention director, not a defect predictor: it
 * surfaces a heavily-used export that is both slow to read and actively changing.
 * Complexity is the export's OWN cognitive complexity (C-58, per-symbol) when
 * known, falling back to the file's max for exports without a computed symbol
 * complexity (e.g. class or re-exported symbols). This is what lets two exports
 * of one hot file separate instead of tying on the file-broadcast value.
 * Stable files (churn 0) score 0 and drop out — a load-bearing export in a calm
 * file isn't a change hazard.
 */
declare function buildBlastRadius(symbols: readonly SymbolUtil[], metrics: ReadonlyMap<string, NodeMetrics>, churnByFile: ReadonlyMap<string, number>, limit?: number): BlastRadiusEntry[];

type Severity = "error" | "warning";
interface MetricMaxRule {
    type: "metric-max";
    id: string;
    metric: string;
    max: number;
    kind?: NodeKind;
    severity?: Severity;
    exclude?: string[];
    excludeRoles?: NodeRole[];
}
interface MetricMinRule {
    type: "metric-min";
    id: string;
    metric: string;
    min: number;
    kind?: NodeKind;
    severity?: Severity;
    exclude?: string[];
    excludeRoles?: NodeRole[];
}
interface MetricProductMaxRule {
    type: "metric-product-max";
    id: string;
    metrics: string[];
    max: number;
    kind?: NodeKind;
    severity?: Severity;
    exclude?: string[];
    excludeRoles?: NodeRole[];
}
/** Flags nodes whose value sits strictly above the given percentile of the metric over every node of the kind. */
interface MetricOutlierRule {
    type: "metric-outlier";
    id: string;
    metric: string;
    kind: NodeKind;
    /** 50 to 100; the threshold interpolates linearly between the two nearest ranked values. */
    percentile: number;
    /** Fewest nodes that must carry the metric before any is judged; defaults to 20. */
    minSample?: number;
    /** A node is flagged only if its value also exceeds this absolute floor, guarding sparse metrics whose percentile sits at or near zero. */
    floor?: number;
    /** When true, rank and gate on the pool of carriers with a non-zero value only; zero-valued nodes are never flagged. */
    rankNonZero?: boolean;
    severity?: Severity;
}
interface ForbidImportRule {
    type: "forbid-import";
    id: string;
    from: string;
    to: string;
    /** Destination patterns `to` matches but the rule allows, such as one sanctioned entry file. */
    except?: string[];
    severity?: Severity;
}
interface LayeredDepsRule {
    type: "layered-deps";
    id: string;
    layers: string[][];
    severity?: Severity;
    /** An import is dropped when its source or destination file has one of these roles. */
    excludeRoles?: NodeRole[];
    /** Skip `import type` / `export type … from` edges; defaults to false so a type-only reach upward still counts. */
    exemptTypeOnly?: boolean;
}
interface NoInternalOnlyBarrelsRule {
    type: "no-internal-only-barrels";
    id: string;
    /** Path prefixes marking package roots; node ids carry no intrinsic package membership. */
    packageRoots: string[];
    severity?: Severity;
    /** Globs or substrings to skip, such as CLI bin entries the role classifier calls barrels. */
    exclude?: string[];
}
/** One violation per strongly connected component of the file import graph, naming every member file. */
interface NoImportCyclesRule {
    type: "no-import-cycles";
    id: string;
    severity?: Severity;
    /** Globs or substrings; a matching file leaves the graph, so a cycle through it is not reported. */
    exclude?: string[];
    /** A file with one of these roles leaves the graph. */
    excludeRoles?: NodeRole[];
    /** Count `import type` edges too; defaults to false because type-only imports are erased at runtime. */
    includeTypeOnly?: boolean;
}
type CheckRule = MetricMaxRule | MetricMinRule | MetricProductMaxRule | MetricOutlierRule | ForbidImportRule | LayeredDepsRule | NoInternalOnlyBarrelsRule | NoImportCyclesRule;
interface CheckRulesFile {
    rules: CheckRule[];
}
type CycleKind = "value" | "type-only";
interface CheckViolation {
    ruleId: string;
    severity: Severity;
    nodeId: string;
    message: string;
    metric?: string;
    value?: number;
    threshold?: number;
    destinationId?: string;
    /** Sorted member files of a cycle; part of the violation's identity, so a changed cycle keys differently. */
    members?: string[];
    /** A cycle's kind: `type-only` when its value imports alone close no cycle. Not part of the key. */
    cycleKind?: CycleKind;
    /** A type-only cycle's member with the most type-only imports in from other members. Not part of the key. */
    hub?: string;
    isCarryover?: boolean;
    /** Repo-relative file the violation sits in; a symbol's parent file. */
    path?: string;
    lineStart?: number;
    lineEnd?: number;
    symbol?: string;
    /** One line a reader can check without re-running the rule, such as `loc=412 (max 350)`. */
    evidence?: string;
    tool?: string;
}
interface CheckResult {
    snapshotId: number;
    baselineSnapshotId?: number;
    rulesEvaluated: number;
    nodesEvaluated: number;
    violations: CheckViolation[];
    newErrors: number;
    newWarnings: number;
    carryoverErrors: number;
    carryoverWarnings: number;
    passed: boolean;
}

/** The fields that identify a violation; a finding read back from an export carries them too. */
type ViolationIdentity = Pick<CheckViolation, "ruleId" | "nodeId" | "destinationId" | "members">;
/** Identity of a violation across snapshots: severity, value and message may change, the key does not. */
declare function violationKey(v: ViolationIdentity): string;
/** {@link violationKey} with every node id carried into another snapshot's id space; unmoved ids key as before. */
declare function rebasedViolationKey(v: ViolationIdentity, resolve: (id: string) => string): string;

/** What bucketing reads from a violation: its identity and, when the rule measures one, its value and threshold. */
type BucketableViolation = ViolationIdentity & Pick<CheckViolation, "value" | "threshold">;
type ExcessChange = "worsened" | "improved" | "unchanged";
/**
 * How far past its threshold a violation sits; larger is worse for every rule: value over
 * threshold for a maximum, threshold over value for a minimum. Null when either is missing
 * or the ratio has no meaning.
 */
declare function violationExcess(ruleType: string | undefined, value?: number, threshold?: number): number | null;
/** Worsened when the excess grew; null when either side has none, so an unmeasured pair is never called better or worse. */
declare function compareExcess(before: number | null, after: number | null): ExcessChange | null;
interface UnchangedViolation<V extends BucketableViolation = CheckViolation> {
    from: V;
    to: V;
    delta: number | null;
}
interface ViolationBuckets<V extends BucketableViolation = CheckViolation> {
    newViolations: V[];
    resolvedViolations: V[];
    unchanged: UnchangedViolation<V>[];
    worsened: UnchangedViolation<V>[];
    improved: UnchangedViolation<V>[];
}
/**
 * Bucket two snapshots' violations as new, resolved, or unchanged, and an unchanged one as
 * worsened or improved when it moved further past or back toward its threshold
 * ({@link violationExcess}). `resolve` carries from-side ids into the to-snapshot, so a moved
 * file's violations stay unchanged; omitted, ids match as they are. `ruleTypeOf` names each
 * rule's type; omitted, every rule reads as a maximum. Needs no store.
 */
declare function bucketViolations<V extends BucketableViolation>(from: readonly V[], to: readonly V[], resolve?: (id: string) => string, ruleTypeOf?: (ruleId: string) => string | undefined): ViolationBuckets<V>;

/**
 * Symbol-level change coupling (C-60). Decomposes a god-file the file-level
 * coupling view rolls up as one blob (e.g. `types.ts`) into *which symbol* is
 * used where. Built on the C-53 `references` edge substrate: `src` is the
 * importing file, `dst` is the imported symbol node id (`<fileId>#<name>`).
 *
 * Two slices, both pure functions of the assembled reference edge set (a
 * whole-graph rollup like utilization/PageRank, sound under incremental reuse
 * since it reads the reassembled edges, not a per-file cache):
 *
 * - **Slice C — per-symbol consumers**: invert the edges by `dst`, giving the
 *   set of files that import each symbol. Directly answers "what IN this file is
 *   used where"; covers span-less types/consts that a git-hunk approach cannot.
 * - **Slice B — co-import coupling**: group edges by `src`, and every pair of
 *   symbols co-imported by the same file is a coupling pair. Two symbols that
 *   are always imported together travel together — structural (used-together),
 *   drift-free coupling, as opposed to the temporal (changed-together) git
 *   co-edit signal.
 */
/** The minimal shape of a `references` edge this module consumes. */
interface ReferenceEdgeLite {
    /** Importing file id. */
    srcId: string;
    /** Imported symbol node id (`<fileId>#<name>`). */
    dstId: string;
}
/** One symbol's consumer set (Slice C). */
interface SymbolConsumers {
    symbolId: string;
    /** Declaring file, parsed from the symbol id. */
    fileId: string;
    /** Export name. */
    name: string;
    /** Distinct importing file ids, sorted. */
    consumers: string[];
}
/** A pair of symbols co-imported by the same file (Slice B). */
interface SymbolCouplingPair {
    aId: string;
    aFile: string;
    aName: string;
    bId: string;
    bFile: string;
    bName: string;
    /** Distinct files that import both symbols. */
    coImports: number;
    /** True when the two symbols are declared in different files. */
    crossFile: boolean;
}
interface SymbolCouplingOptions {
    /** Skip pairs co-imported by fewer than this many files. Default 2. */
    minCoImports?: number;
    /**
     * Skip importing files that reference more than this many distinct symbols —
     * a wide barrel-style importer would otherwise explode into O(n²) noise
     * pairs, mirroring change-coupling's large-commit guard. Default 40.
     */
    largeImporterThreshold?: number;
}
/**
 * Group reference edges by imported symbol, yielding each symbol's distinct
 * consuming files (Slice C). Sorted by consumer count desc, then symbol id, so
 * the most broadly-depended-on exports lead.
 */
declare function computeSymbolConsumers(edges: readonly ReferenceEdgeLite[]): SymbolConsumers[];
/**
 * Every pair of symbols co-imported by the same file becomes a coupling pair,
 * counted by how many distinct files co-import them (Slice B). Wide importers
 * are dropped to keep the pairing near-linear. Sorted by co-import count desc,
 * cross-file pairs preferred at a tie (they are the actionable ones — a
 * same-file pair is just cohesion within one module).
 */
declare function computeSymbolCoupling(edges: readonly ReferenceEdgeLite[], options?: SymbolCouplingOptions): SymbolCouplingPair[];

/**
 * Dashboard payload assembly for symbol-level coupling (C-60). Turns the raw
 * `references` edge set into two lean, capped slices the Coupling view renders,
 * so a god-file like `types.ts` decomposes into *which symbol goes where*
 * instead of one aggregate file node:
 *
 * - **Slice B — `symbolCoupling`**: symbol pairs consistently co-imported by the
 *   same files (structural, used-together coupling; drift-free).
 * - **Slice C — `symbolConsumers`**: per-file groups of exported symbols with
 *   the files that consume each — the literal "what IN this file is used where".
 *
 * Kept out of dashboard-payload.ts (at its LOC ceiling) so that file stays lean.
 */
/** One co-imported symbol pair, dashboard-lean (Slice B). */
interface SymbolCouplingRow {
    aName: string;
    aFile: string;
    bName: string;
    bFile: string;
    coImports: number;
    crossFile: boolean;
}
/** One symbol and the files that consume it (Slice C). */
interface SymbolConsumerRow {
    name: string;
    /** Up to CONSUMER_SAMPLE consuming file ids. */
    consumers: string[];
    /** Full distinct-consumer count (consumers may be truncated). */
    consumerCount: number;
}
/** A file's shared exports and where each goes (Slice C, grouped for the view). */
interface SymbolConsumerGroup {
    fileId: string;
    symbols: SymbolConsumerRow[];
    /** Sum of consumer counts across kept symbols — the group's ordering weight. */
    totalConsumers: number;
}
interface SymbolCouplingPayload {
    symbolCoupling: SymbolCouplingRow[];
    symbolConsumers: SymbolConsumerGroup[];
}
declare function buildSymbolCouplingPayload(edges: readonly ReferenceEdgeLite[]): SymbolCouplingPayload;

/**
 * Snapshot-level (window-independent) derived data: which file pairs are joined
 * by a static import edge, and each node's PageRank centrality. Computed once
 * per snapshot from a single db open, shared across all window payloads.
 */
interface SnapshotContext {
    linkedPairs: ReadonlySet<string>;
    centrality: ReadonlyMap<string, number>;
    /**
     * Ids of files that participate in at least one *internal* (repo-to-repo)
     * import/re-export edge. A file missing here has no resolved imports in the
     * graph — either it isn't indexed, or its imports couldn't be resolved (e.g. a
     * dir outside the tsconfig project, whose relative specifiers resolve to junk).
     * Either way the import evidence is absent, so a co-change touching it can't be
     * called hidden-vs-import-backed; it's "unverifiable", not "hidden".
     */
    connectedNodes: ReadonlySet<string>;
    /** Per-node structural metrics (loc, cognitive/cyclomatic max, nesting, fan) for the Dossier. */
    metrics: ReadonlyMap<string, NodeMetrics>;
    /** Per-export utilization (C-53), for the Dossier "hot exports" list and the blast-radius section. */
    symbols: readonly SymbolUtil[];
    /** Inbound `references` count per symbol id (C-59): how many files consume each export. */
    consumersBySymbol: ReadonlyMap<string, number>;
    /** Symbol-level coupling slices (C-60): co-imported pairs + per-symbol consumers. */
    symbolCoupling?: SymbolCouplingPayload;
}
type CouplingClass = {
    hidden: boolean;
    unindexed: boolean;
};
/**
 * Classify a co-changed pair against the static import graph:
 * - unindexed: an endpoint has no resolved internal imports → can't tell (not hidden).
 * - hidden: both connected, but no import/re-export edge joins them → the signal.
 * - expected: both connected and import-backed → usually fine.
 */
declare function classifyCoupling(a: string, b: string, ctx: SnapshotContext): CouplingClass;
/** Order-independent key for an undirected file pair (JSON tuple; no in-band separator). */
declare function pairKey(a: string, b: string): string;

/**
 * Per-package and per-pair structural quality metrics, plus an overall
 * Newman-Girvan modularity Q for the package partition.
 *
 * Operates on a barrel-resolved edge set by default: edges that land on a
 * file with role="barrel" are rewritten to land on the underlying files
 * the barrel re-exports from (transitively). The intent is to measure the
 * real dependency surface, not the re-export plumbing.
 *
 * See C-8 task notes for the design rationale and empirical calibration
 * data from the 2026-05-21 codewatch dogfood.
 */
interface PartitionQualityInput {
    /** Logical packages — at minimum needs an id. */
    packages: ReadonlyArray<{
        id: string;
    }>;
    /** Package id → list of file ids assigned to that package. */
    fileByPackage: ReadonlyMap<string, ReadonlyArray<string>>;
    /** All file/module/external nodes for the snapshot. Used to identify role="barrel". */
    nodes: readonly GraphNode[];
    /** All edges for the snapshot. */
    edges: readonly GraphEdge[];
    /**
     * When true, edges landing on a barrel file are resolved through its
     * re-export chain to the underlying source files. The cheap implementation
     * fans each barrel import into N synthetic edges (one per re-export
     * target), which over-attributes — a single `import { x } from "./pkg"`
     * becomes N edges as if every re-export were used. Default false until
     * a weighted or symbol-tracking version is available.
     */
    resolveBarrels?: boolean;
}
type PackageFlag = "weak-boundary";
type PairFlag = "tight" | "moderate" | "none";
type PackageLayer = "top" | "middle" | "foundation";
interface PackageStats {
    pkgId: string;
    fileCount: number;
    internalEdges: number;
    outgoingEdges: number;
    incomingEdges: number;
    /** internal / (internal + outgoing) — higher = more self-contained. */
    cohesion: number;
    /** outgoing / (outgoing + incoming) — Martin's I metric at the package level. */
    instability: number;
    /**
     * Abstractness proxy A ∈ [0,1]: share of the package's files with role
     * "types" (dedicated type/interface definitions). codewatch has no
     * symbol-level abstract/concrete counts, so this file-role ratio stands in
     * for Martin's A. Enables the instability×abstractness main-sequence plot.
     */
    abstractness: number;
    layer: PackageLayer;
    flags: PackageFlag[];
}
interface PairCoupling {
    from: string;
    to: string;
    edges: number;
    /** edges / files(from) — fraction of from-side files contributing dependencies into `to`. */
    intensity: number;
    flag: PairFlag;
}
interface PartitionQualityResult {
    modularityQ: number;
    totalEdges: number;
    perPackage: PackageStats[];
    pairCoupling: PairCoupling[];
    /** Total raised flags across packages + pairs (excluding "moderate"). */
    flagsCount: number;
}
declare function computePartitionQuality(input: PartitionQualityInput): PartitionQualityResult;
/**
 * Invert a package→files bucket map into a file→package lookup, skipping the
 * empty-string "unassigned" bucket. Shared by partition-quality and the CLI's
 * arch/wiki package rollups, which all need the same file→package direction.
 */
declare function invertBuckets(fileByPackage: ReadonlyMap<string, ReadonlyArray<string>>): Map<string, string>;

/** A top-level sub-directory of a drilled package, rendered inside its cluster. */
interface ArchSubNode {
    /** Full path id, e.g. "packages/cli/src/commands". */
    id: string;
    /** Directory name shown as the node label, e.g. "commands". */
    label: string;
    files: number;
}
interface ArchPackage {
    id: string;
    name: string;
    files: number;
    /** Present when the package was drilled (--depth modules); renders as a subgraph. */
    subNodes?: ArchSubNode[];
}
interface ArchEdge {
    from: string;
    to: string;
    count: number;
}
interface ArchResult {
    snapshot: SnapshotRow;
    packages: ArchPackage[];
    edges: ArchEdge[];
    includesExternal: boolean;
    /** Present when options.health=true. */
    quality?: PartitionQualityResult;
}

declare const EXTERNAL_BUCKET = "(external)";
/** Default file-count threshold above which a package is drilled (C-10). */
declare const DEFAULT_MAX_PACKAGE_SIZE = 30;
interface ComputeArchInput {
    snapshot: SnapshotRow;
    nodes: readonly GraphNode[];
    edges: readonly GraphEdge[];
    packages: readonly PackageRoot[];
    exclude?: string[];
    excludeRole?: string[];
    includeExternal?: boolean;
    minEdges?: number;
    depth?: "modules";
    maxPackageSize?: number;
}
declare function computeArch(input: ComputeArchInput): ArchResult;
declare function filteredFileIds(nodes: readonly GraphNode[], options: {
    exclude?: string[];
    excludeRole?: string[];
}): string[];
declare function aggregateEdges(edges: ReadonlyArray<{
    srcId: string;
    dstId: string;
}>, pkgByFile: ReadonlyMap<string, string>, nodeByFile: ReadonlyMap<string, string>, externalIds: ReadonlySet<string>, includeExternal: boolean): Map<string, Map<string, number>>;
declare function toSortedEdges(counts: ReadonlyMap<string, ReadonlyMap<string, number>>, minEdges: number): ArchEdge[];
declare function packagesReferencedByEdges(counts: ReadonlyMap<string, ReadonlyMap<string, number>>): Set<string>;

/** How a test↔source pairing was inferred. */
type LinkMethod = "path" | "coedit";
interface TestSourceLink {
    /** Node id of the test file. */
    testId: string;
    /** Node id of the (non-test) file it covers. */
    sourceId: string;
    method: LinkMethod;
}
interface LinkTestsOptions {
    /** Minimum co-edit count for a pass-2 (coedit) link. Default 2. */
    minCoEditCount?: number;
}
/**
 * Two-pass test↔source linker. Pass 1 pairs each test file with non-test files
 * matching its path conventions, pytest's `test_<name>.py` included (high
 * confidence). Pass 2 supplements tests
 * left unpaired by pass 1 with their strongest co-edited non-test partner from
 * change-coupling. Handles orphan tests (no pairing), orphan/untested sources
 * (no incoming link), and one-to-many pairings (a test matching several
 * sources, or a source covered by several tests).
 */
declare function linkTestsToSources(nodes: readonly GraphNode[], coEditPairs: readonly CoEditPair[], options?: LinkTestsOptions): TestSourceLink[];
/**
 * Per-source coverage breadth: how many distinct test files link to each
 * covered source. Emitted only for sources with at least one linked test.
 */
declare function testCoverageCountMetrics(links: readonly TestSourceLink[]): GraphMetric[];
/** Map each covered source to the set of test files that link to it. */
declare function groupTestsBySource(links: readonly TestSourceLink[]): Map<string, Set<string>>;

export { type GrowthRiskRow as $, type ArchEdge as A, type BlastRadiusEntry as B, type CheckResult as C, type CouplingClass as D, type EdgeKind as E, type FileFingerprint as F, type GraphNode as G, type CouplingDelta as H, type IdAlias as I, type CouplingRow as J, type CycleKind as K, DEFAULT_HEALTH_WEIGHTS as L, DEFAULT_MAX_PACKAGE_SIZE as M, type NodeKind as N, type DeadModuleConsumer as O, type DeadModuleRow as P, type DeadModuleView as Q, type ReferenceEdgeLite as R, type SnapshotRow as S, type TestSourceLink as T, type DeadModulesOptions as U, type ViolationBuckets as V, EXTERNAL_BUCKET as W, EXTREME_CC as X, type ExcessChange as Y, type ForbidImportRule as Z, type GraphReportResult as _, type GraphEdge as a, complexityDistribution as a$, HIGH_CC as a0, type HealthComponent as a1, type HealthComponentKey as a2, type HealthInput as a3, type HealthWeights as a4, type HotExport as a5, type HotspotDelta as a6, type HotspotRow as a7, type ImportCyclicMass as a8, type LayeredDepsRule as a9, type SnapshotContext as aA, type SymbolConsumerGroup as aB, type SymbolConsumerRow as aC, type SymbolCouplingPayload as aD, type SymbolCouplingRow as aE, type SymbolUtil as aF, type TestCoverageRow as aG, type UnchangedViolation as aH, type UntestedRiskRow as aI, type UnusedExportRow as aJ, type ViolationIdentity as aK, type WeightedLink as aL, aggregateEdges as aM, bucketFilesByPackage as aN, bucketViolations as aO, buildBlastRadius as aP, buildCentralFiles as aQ, buildHotExports as aR, buildNodeMetrics as aS, buildReportContext as aT, buildSymbolCouplingPayload as aU, busFactorOf as aV, callGraphMetrics as aW, classifyCoupling as aX, collectNodeMetrics as aY, collectSymbolUtil as aZ, compareExcess as a_, type LinkMethod as aa, type LinkTestsOptions as ab, type MetricMaxRule as ac, type MetricMinRule as ad, type MetricOutlierRule as ae, type MetricProductMaxRule as af, NODE_KINDS as ag, NODE_ROLES as ah, type NewHotspot as ai, type NoImportCyclesRule as aj, type NoInternalOnlyBarrelsRule as ak, type PackageComplexityRow as al, type PackageDependencyRow as am, type PackageFlag as an, type PackageLayer as ao, type PackageRoot as ap, type PackageStats as aq, type PairCoupling as ar, type PairFlag as as, type PartitionQualityInput as at, type PartitionQualityResult as au, type PenaltyWeight as av, type QualitySection as aw, type ReportContext as ax, type ReportContextInput as ay, type ReportDrift as az, type GraphMetric as b, computeArch as b0, computeHealth as b1, computePartitionQuality as b2, computeReportDrift as b3, computeSymbolConsumers as b4, computeSymbolCoupling as b5, dependencyGraphMetrics as b6, filteredFileIds as b7, groupTestsBySource as b8, hotspotScoreOf as b9, importCyclicMass as ba, invertBuckets as bb, keepNode as bc, linkTestsToSources as bd, lookupMetric as be, packagesReferencedByEdges as bf, pairKey as bg, publicApiFiles as bh, qualitySection as bi, rebasedViolationKey as bj, referencedNodes as bk, summarizeComplexity as bl, testCoverageCountMetrics as bm, toSortedEdges as bn, topBusFactorRisks as bo, topCentralFiles as bp, topDeadModules as bq, topGrowthRisks as br, topHotspots as bs, topTestCoverageRisks as bt, topUntestedRisks as bu, topUnusedExports as bv, violationExcess as bw, violationKey as bx, hotspotComplexityOf as by, type GraphFragment as c, type NodeRole as d, type IdAliasReason as e, type Severity as f, type NodeMetrics as g, type SymbolConsumers as h, type SymbolCouplingOptions as i, type SymbolCouplingPair as j, type CheckRule as k, type CheckViolation as l, type ArchPackage as m, type ArchResult as n, type ArchSubNode as o, type BucketableViolation as p, type BusFactorChange as q, type BusFactorRow as r, type CallGraphMetrics as s, type CallableComplexity as t, type CentralRow as u, type CheckRulesFile as v, type ComplexityDistribution as w, type ComplexityRollup as x, type ComputeArchInput as y, type ComputeDriftInput as z };

// ./dist/change-coupling.d.ts
/**
 * A churn window is either a rolling N-day window or `"lifetime"` = all of git
 * history (no `--since` bound). Lifetime mode lets an unfamiliar repo be audited
 * cold, where any recent rolling slice is thin relative to the repo's whole
 * life, so a windowed view reads an established repo as nearly churn-free.
 */
type ChurnWindow = number | "lifetime";

declare function detectGitToplevel(cwd: string): string | null;
type GitLargeFailure = "not-git" | "overflow" | "git-error";
/** A history load that is neither a success nor a plain "not a git checkout". */
declare class GitHistoryError extends Error {
    readonly reason: Exclude<GitLargeFailure, "not-git">;
    readonly detail: string;
    constructor(reason: Exclude<GitLargeFailure, "not-git">, detail: string);
}
type HistoryLoad<T> = {
    ok: true;
    value: T;
} | {
    ok: false;
    reason: GitLargeFailure;
    detail: string;
};

interface ChurnEntry {
    commit: string;
    /** Author identity: git author email (%ae), stable across name spelling drift. */
    author: string;
    /** Committer time (%ct), epoch seconds; lets one wide log be sliced per window. */
    epoch: number;
    /** Repo-relative posix path, rebased onto the caller's root. */
    filePath: string;
    added: number;
    deleted: number;
}
interface LoadChurnOptions {
    /** Directory paths are made relative to; entries outside it are dropped. */
    repoRoot: string;
    windowDays?: ChurnWindow;
    /** Walk history from this rev instead of HEAD. */
    rev?: string;
    /** Epoch seconds a finite window ends at; defaults to the wall clock. */
    untilEpoch?: number;
}
/**
 * Parse the last `windowDays` of git history up to `rev` (default HEAD) into ChurnEntry[] rebased onto
 * `repoRoot`. Returns null when `repoRoot` is not a git checkout or git is missing; [] if no commits matched.
 * Throws a `GitHistoryError` when git ran but failed or its log overflowed the buffer, because the
 * history exists and a null would silently pass for "no history". Use {@link loadChurnResult} to branch
 * on the outcome instead. Used both for churn metrics and for change-coupling.
 */
declare function loadChurnEntries(options: LoadChurnOptions): ChurnEntry[] | null;
/** {@link loadChurnEntries} with the failure kind (`not-git`, `overflow`, `git-error`) kept apart. */
declare function loadChurnResult(options: LoadChurnOptions): HistoryLoad<ChurnEntry[]>;
declare function parseChurnLog(text: string): ChurnEntry[];
declare function resolveRenamedPath(rawPath: string): string;
/** Entries whose commit landed within the last `windowDays` of `nowEpoch`. */
declare function entriesWithin(entries: readonly ChurnEntry[], windowDays: number, nowEpoch: number): ChurnEntry[];

interface CoEditPair {
    fileA: string;
    fileB: string;
    /** Commits in which both files changed. */
    count: number;
    /** Most recent commits (up to maxCommitsPerPair). */
    commits: string[];
}
interface ComputeChangeCouplingOptions {
    /** Skip pairs that co-occur in fewer than this many commits. Default 2. */
    minCount?: number;
    /** Truncate the commits sample per pair. Default 10. */
    maxCommitsPerPair?: number;
    /**
     * Skip commits touching more than this many files (sweeping refactors, mass
     * renames). Default 50: beyond that the O(n²) pair explosion is signal-poor.
     */
    largeCommitThreshold?: number;
    /** Filter file paths to this set before pairing. */
    knownPaths?: ReadonlySet<string>;
}
interface ChangeCouplingResult {
    pairs: CoEditPair[];
    /** Commits dropped by largeCommitThreshold, so callers can say when sweeps suppressed the signal. */
    skippedLargeCommits: number;
    /** Threshold that was applied (echoed for diagnostic messages). */
    largeCommitThreshold: number;
}
interface CouplingPartner {
    partner: string;
    count: number;
    commits: string[];
}
declare function computeChangeCoupling(entries: readonly ChurnEntry[], options?: ComputeChangeCouplingOptions): ChangeCouplingResult;
/** Files most coupled to `seed`, by co-edit count desc then path; the seed itself is excluded. */
declare function couplingFor(pairs: readonly CoEditPair[], seed: string): CouplingPartner[];

export { type ChurnEntry as C, GitHistoryError as G, type HistoryLoad as H, type LoadChurnOptions as L, type ChurnWindow as a, type ChangeCouplingResult as b, type CoEditPair as c, type ComputeChangeCouplingOptions as d, type CouplingPartner as e, type GitLargeFailure as f, computeChangeCoupling as g, couplingFor as h, entriesWithin as i, loadChurnResult as j, detectGitToplevel as k, loadChurnEntries as l, parseChurnLog as p, resolveRenamedPath as r };
