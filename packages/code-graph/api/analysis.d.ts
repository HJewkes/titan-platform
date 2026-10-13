export { A as ArchEdge, m as ArchPackage, n as ArchResult, o as ArchSubNode, B as BlastRadiusEntry, p as BucketableViolation, q as BusFactorChange, r as BusFactorRow, s as CallGraphMetrics, t as CallableComplexity, u as CentralRow, w as ComplexityDistribution, x as ComplexityRollup, y as ComputeArchInput, z as ComputeDriftInput, D as CouplingClass, H as CouplingDelta, J as CouplingRow, L as DEFAULT_HEALTH_WEIGHTS, M as DEFAULT_MAX_PACKAGE_SIZE, O as DeadModuleConsumer, P as DeadModuleRow, Q as DeadModuleView, U as DeadModulesOptions, W as EXTERNAL_BUCKET, X as EXTREME_CC, Y as ExcessChange, _ as GraphReportResult, $ as GrowthRiskRow, a0 as HIGH_CC, a1 as HealthComponent, a2 as HealthComponentKey, a3 as HealthInput, a4 as HealthWeights, a5 as HotExport, a6 as HotspotDelta, a7 as HotspotRow, a8 as ImportCyclicMass, ai as NewHotspot, f as NodeMetrics, al as PackageComplexityRow, am as PackageDependencyRow, ap as PackageRoot, aq as PackageStats, ar as PairCoupling, at as PartitionQualityInput, au as PartitionQualityResult, av as PenaltyWeight, aw as QualitySection, ax as ReportContext, ay as ReportContextInput, az as ReportDrift, aA as SnapshotContext, aB as SymbolConsumerGroup, aC as SymbolConsumerRow, g as SymbolConsumers, aD as SymbolCouplingPayload, aE as SymbolCouplingRow, aF as SymbolUtil, aG as TestCoverageRow, T as TestSourceLink, aH as UnchangedViolation, aI as UntestedRiskRow, aJ as UnusedExportRow, V as ViolationBuckets, aL as WeightedLink, aM as aggregateEdges, aN as bucketFilesByPackage, aO as bucketViolations, aP as buildBlastRadius, aQ as buildCentralFiles, aR as buildHotExports, aS as buildNodeMetrics, aT as buildReportContext, aU as buildSymbolCouplingPayload, aV as busFactorOf, aW as callGraphMetrics, aX as classifyCoupling, aY as collectNodeMetrics, aZ as collectSymbolUtil, a_ as compareExcess, a$ as complexityDistribution, b0 as computeArch, b1 as computeHealth, b2 as computePartitionQuality, b3 as computeReportDrift, b4 as computeSymbolConsumers, b6 as dependencyGraphMetrics, b7 as filteredFileIds, by as hotspotComplexityOf, b9 as hotspotScoreOf, ba as importCyclicMass, bc as keepNode, bd as linkTestsToSources, be as lookupMetric, bf as packagesReferencedByEdges, bg as pairKey, bh as publicApiFiles, bi as qualitySection, bk as referencedNodes, bl as summarizeComplexity, bn as toSortedEdges, bo as topBusFactorRisks, bp as topCentralFiles, bq as topDeadModules, br as topGrowthRisks, bs as topHotspots, bt as topTestCoverageRisks, bu as topUntestedRisks, bv as topUnusedExports, bw as violationExcess } from '../browser.js';
import '../change-coupling.js';

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
/** CY, PC and ENT over one graph. Links must join listed nodes; parallel links should already be merged into one weight. */
declare function callGraphMetrics(nodeIds: readonly string[], links: readonly WeightedLink[]): CallGraphMetrics;
/** {@link ImportCyclicMass} over file imports, `typeOnly` marking the links that carry only types. */
declare function importCyclicMass(fileIds: readonly string[], links: readonly (WeightedLink & {
    typeOnly: boolean;
})[]): ImportCyclicMass;
/**
 * The SCBench dependency-graph measures per package: CY, PC and ENT over `calls` between the
 * symbol nodes given, and cyclic import mass between the file nodes given. Only edges whose
 * ends are both given and in one package count. PC costs O(n·(n + e)) per package, so there is
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

export { type GrowthRiskRow as $, type ArchEdge as A, type BlastRadiusEntry as B, type CheckRule as C, type CouplingClass as D, type EdgeKind as E, type FileFingerprint as F, type GraphNode as G, type CouplingDelta as H, type IdAlias as I, type CouplingRow as J, type CycleKind as K, DEFAULT_HEALTH_WEIGHTS as L, DEFAULT_MAX_PACKAGE_SIZE as M, type NodeKind as N, type DeadModuleConsumer as O, type DeadModuleRow as P, type DeadModuleView as Q, type ReferenceEdgeLite as R, type SnapshotRow as S, type TestSourceLink as T, type DeadModulesOptions as U, type ViolationBuckets as V, EXTERNAL_BUCKET as W, EXTREME_CC as X, type ExcessChange as Y, type ForbidImportRule as Z, type GraphReportResult as _, type GraphEdge as a, complexityDistribution as a$, HIGH_CC as a0, type HealthComponent as a1, type HealthComponentKey as a2, type HealthInput as a3, type HealthWeights as a4, type HotExport as a5, type HotspotDelta as a6, type HotspotRow as a7, type ImportCyclicMass as a8, type LayeredDepsRule as a9, type SnapshotContext as aA, type SymbolConsumerGroup as aB, type SymbolConsumerRow as aC, type SymbolCouplingPayload as aD, type SymbolCouplingRow as aE, type SymbolUtil as aF, type TestCoverageRow as aG, type UnchangedViolation as aH, type UntestedRiskRow as aI, type UnusedExportRow as aJ, type ViolationIdentity as aK, type WeightedLink as aL, aggregateEdges as aM, bucketFilesByPackage as aN, bucketViolations as aO, buildBlastRadius as aP, buildCentralFiles as aQ, buildHotExports as aR, buildNodeMetrics as aS, buildReportContext as aT, buildSymbolCouplingPayload as aU, busFactorOf as aV, callGraphMetrics as aW, classifyCoupling as aX, collectNodeMetrics as aY, collectSymbolUtil as aZ, compareExcess as a_, type LinkMethod as aa, type LinkTestsOptions as ab, type MetricMaxRule as ac, type MetricMinRule as ad, type MetricOutlierRule as ae, type MetricProductMaxRule as af, NODE_KINDS as ag, NODE_ROLES as ah, type NewHotspot as ai, type NoImportCyclesRule as aj, type NoInternalOnlyBarrelsRule as ak, type PackageComplexityRow as al, type PackageDependencyRow as am, type PackageFlag as an, type PackageLayer as ao, type PackageRoot as ap, type PackageStats as aq, type PairCoupling as ar, type PairFlag as as, type PartitionQualityInput as at, type PartitionQualityResult as au, type PenaltyWeight as av, type QualitySection as aw, type ReportContext as ax, type ReportContextInput as ay, type ReportDrift as az, type GraphMetric as b, computeArch as b0, computeHealth as b1, computePartitionQuality as b2, computeReportDrift as b3, computeSymbolConsumers as b4, computeSymbolCoupling as b5, dependencyGraphMetrics as b6, filteredFileIds as b7, groupTestsBySource as b8, hotspotScoreOf as b9, importCyclicMass as ba, invertBuckets as bb, keepNode as bc, linkTestsToSources as bd, lookupMetric as be, packagesReferencedByEdges as bf, pairKey as bg, publicApiFiles as bh, qualitySection as bi, rebasedViolationKey as bj, referencedNodes as bk, summarizeComplexity as bl, testCoverageCountMetrics as bm, toSortedEdges as bn, topBusFactorRisks as bo, topCentralFiles as bp, topDeadModules as bq, topGrowthRisks as br, topHotspots as bs, topTestCoverageRisks as bt, topUntestedRisks as bu, topUnusedExports as bv, violationExcess as bw, violationKey as bx, hotspotComplexityOf as by, type GraphFragment as c, type NodeRole as d, type IdAliasReason as e, type NodeMetrics as f, type SymbolConsumers as g, type SymbolCouplingOptions as h, type SymbolCouplingPair as i, type CheckResult as j, type CheckViolation as k, type Severity as l, type ArchPackage as m, type ArchResult as n, type ArchSubNode as o, type BucketableViolation as p, type BusFactorChange as q, type BusFactorRow as r, type CallGraphMetrics as s, type CallableComplexity as t, type CentralRow as u, type CheckRulesFile as v, type ComplexityDistribution as w, type ComplexityRollup as x, type ComputeArchInput as y, type ComputeDriftInput as z };

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
