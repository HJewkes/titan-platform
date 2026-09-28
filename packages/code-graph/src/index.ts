export type {
  EdgeKind,
  FileFingerprint,
  GraphEdge,
  GraphFragment,
  GraphMetric,
  GraphNode,
  IdAlias,
  IdAliasReason,
  NodeKind,
  NodeRole,
  SnapshotRow,
} from "./types.js";

export type { SnapshotInsert } from "./store.js";
export { CodeGraphStore, openCodeGraph } from "./store.js";
export { DOMAIN_DDL, FINDING_DDL, KIT, MIGRATIONS, SCHEMA_VERSION, SNAPSHOT_SCOPED_TABLES } from "./schema.js";
export type { PruneOptions, PrunePlan, PruneResult } from "./prune.js";
export { planPrune, runPrune } from "./prune.js";

export type { IndexOptions, IndexResult } from "./indexer.js";
export { INDEX_VERSION, indexPaths } from "./indexer.js";

export type { Extractor, ParsedFile } from "@titan-design/code-parser";
export { getLanguageFromPath, getSupportedLanguages, parseFile, shouldIncludeFile } from "@titan-design/code-parser";

export type { LanguageExtractorOptions } from "./extractors/dispatch.js";
export { LanguageExtractor } from "./extractors/dispatch.js";
export { PythonGraphExtractor } from "./extractors/python-extractor.js";
export type { TsMorphGraphExtractorOptions } from "./extractors/ts-morph-extractor.js";
export { TsMorphGraphExtractor } from "./extractors/ts-morph-extractor.js";
export { buildFileModuleNodes } from "./extractors/file-nodes.js";
export type { DeepAst, DeepAstInput, MemberInfo, ParamInfo } from "./extractors/deep-ast.js";
export { computeDeepAst } from "./extractors/deep-ast.js";
export {
  externalId,
  fileId,
  moduleId,
  packageId,
  parentModuleId,
  parseSymbolId,
  symbolId,
  SYMBOL_ID_SEP,
} from "./extractors/ids.js";

export type { ReadFile, ReuseBasis, SourceLanguage } from "./incremental.js";
export { hashContent, readSourceFiles, structuralSignature } from "./incremental.js";
export { walkSourceFiles } from "./file-walk.js";
export { collectDeclaredNames, collectDeclaredSpans, type LineSpan } from "./declared-names.js";
export { edgeWeight, pruneDanglingReferences, resolveBarrelEdges } from "./barrel-resolve.js";
export { ALL_ROLES, annotateRoles, classifyRole, computeRoleHints } from "./roles.js";
export { isGeneratedByHeuristic, isGeneratedFile, loadGeneratedPatterns } from "./generated.js";
export { canonicalEdgeKind, canonicalMetricName, canonicalRole } from "./aliases.js";
export {
  buildAliases,
  detectGitHead,
  detectGitToplevel,
  detectRenames,
  isInsideGitRepo,
  resolveGitRef,
} from "./git-renames.js";
export type { AliasChain, AliasChainInput, AliasLoader, AliasResolution } from "./identity/alias-chain.js";
export { createAliasChain } from "./identity/alias-chain.js";
export type { Lineage, LineageSnapshot, LineageStep } from "./identity/lineage.js";
export { ALIAS_BASE_ATTR, buildLineage, lineagePath } from "./identity/lineage.js";
export type { AliasChainOptions, PriorSnapshotOptions, ResolveAliasOptions } from "./identity/store-identity.js";
export { aliasChain, loadLineage, priorSnapshotForRef, resolveAlias } from "./identity/store-identity.js";
export { computeMetrics } from "./metrics.js";
export { computeSourceMetrics, SOURCE_METRIC_NAMES } from "./source-metrics.js";
export { SYMBOL_METRIC_NAMES } from "./symbol-metrics.js";
export { EXCEPTION_METRIC_NAMES } from "./analysis/exception-handling.js";
export { buildIndexerMetrics } from "./index-metrics.js";
export { computeDeadCodeMetrics, DEAD_CODE_METRIC_NAMES } from "./analysis/dead-code.js";
export { computeGrowthRiskMetrics, GROWTH_RISK_METRIC_NAMES } from "./analysis/growth-risk.js";
export type { LinkMethod, LinkTestsOptions, TestSourceLink } from "./analysis/test-linker.js";
export { groupTestsBySource, linkTestsToSources, testCoverageCountMetrics } from "./analysis/test-linker.js";
export type { IstanbulCoverage, SymbolSpan } from "./analysis/coverage.js";
export { attributeCoverage, COVERAGE_METRIC_NAME } from "./analysis/coverage.js";
/**
 * The history adapter: it turns `./history`'s primitives into `GraphMetric` rows, so it
 * lives at the root rather than behind the `./history` seam, which speaks no graph types.
 */
export type { HistoryMetricsOptions, LoadedHistory, TestCoverageOwnershipOptions } from "./history-metrics.js";
export {
  computeTestCoverageOwnership,
  DEFAULT_CHURN_WINDOWS,
  loadHistoryMetrics,
  resolveChurnWindows,
} from "./history-metrics.js";
export { computeRecencyWindows, windowSuffix } from "./history-recency.js";
export type { PageRankOptions, PageRankResult, PageRankRow } from "./analysis/pagerank.js";
export { computePageRank, getEdgeWeight } from "./analysis/pagerank.js";
export type { RelevanceOptions } from "./analysis/relevance.js";
export { computeRelevance } from "./analysis/relevance.js";
export type {
  ReferenceEdgeLite,
  SymbolConsumers,
  SymbolCouplingOptions,
  SymbolCouplingPair,
} from "./analysis/symbol-coupling.js";
export { computeSymbolConsumers, computeSymbolCoupling } from "./analysis/symbol-coupling.js";
export type {
  PackageFlag,
  PackageLayer,
  PackageStats,
  PairCoupling,
  PairFlag,
  PartitionQualityInput,
  PartitionQualityResult,
} from "./analysis/partition-quality.js";
export { computePartitionQuality, invertBuckets } from "./analysis/partition-quality.js";
export {
  snapshotPageRank,
  snapshotReferenceEdges,
  snapshotRelevance,
  snapshotSymbolConsumers,
  snapshotSymbolCoupling,
} from "./analysis/snapshot.js";

/** Convenience readers over one snapshot; the store carries the full query surface. */
export { listEdges, listMetrics, listNodes } from "./read.js";
export type { MetricAggregate, TopMetricRow } from "./store-reads.js";
export { aggregateMetrics, listEdgesTouching, listMetricsForNode } from "./read.js";
export type {
  MetricAbsence,
  MetricDescriptor,
  MetricDirection,
  MetricRollup,
  MetricSource,
  MetricUnit,
} from "./catalogue/types.js";
export { METRIC_CATALOGUE } from "./catalogue/entries.js";
export { describeMetric, describeMetrics } from "./catalogue/describe.js";

export type {
  CheckResult,
  CheckRule,
  CheckRulesFile,
  CheckViolation,
  ForbidImportRule,
  LayeredDepsRule,
  MetricMaxRule,
  MetricMinRule,
  MetricOutlierRule,
  MetricProductMaxRule,
  NoInternalOnlyBarrelsRule,
  Severity,
} from "./check/types.js";
export type { RunChecksOptions } from "./check/check.js";
export { rebasedViolationKey, runChecks, snapshotViolations, violationKey } from "./check/check.js";
export type { RuleStore } from "./check/context.js";
export type { ExternalDiagnostic, Finding } from "./check/findings.js";
export { externalToFinding, toFindings } from "./check/findings.js";
export type {
  FindingKeyInput,
  StoredFinding,
  StoredVerdict,
  VerdictCitation,
  VerdictLabel,
} from "./check/finding-store.js";
export {
  carryForwardVerdicts,
  findingKey,
  hashText,
  keyFindings,
  listFindings,
  listVerdicts,
  normalizeFlaggedText,
  saveFindings,
  saveVerdicts,
} from "./check/finding-store.js";
export { compilePatterns, matchesAny, patternToRegex } from "./check/patterns.js";
export type { ValidateRulesOptions } from "./check/validate.js";
export { validateRules } from "./check/validate.js";
export { DEFAULT_OUTLIER_MIN_SAMPLE, percentileOf } from "./check/outlier-rule.js";
export type { CheckSnapshotOptions, CheckSnapshotResult, SnapshotSpec } from "./check/run.js";
export { checkSnapshot, loadCheckRules, resolveSnapshot } from "./check/run.js";

export type { GraphDiff, GraphDiffSummary, MetricDelta, NodeRename } from "./diff/types.js";
export type { DiffSnapshotsOptions } from "./diff/diff.js";
export { diffSnapshots } from "./diff/diff.js";
export type { CheckDiff, DiffCheckResultsOptions, UnchangedViolation } from "./diff/check-diff.js";
export { diffCheckResults } from "./diff/check-diff.js";

export type {
  EmbedAttempt,
  EmbedCoverage,
  EmbeddableSymbol,
  EmbedSnapshotResult,
  FindSimilarOptions,
  SimilarCandidate,
  SimilarResult,
} from "./embeddings/types.js";
export { buildEmbedText, hashEmbedText, listEmbeddableSymbols } from "./embeddings/corpus.js";
export type { CachedEmbedResult } from "./embeddings/cache.js";
export { embedTextsCached, SYMBOL_EMBEDDING_NAMESPACE } from "./embeddings/cache.js";
export { embedSnapshot, findSimilarCapability, tryEmbedSnapshot } from "./embeddings/embeddings.js";

export type {
  ConventionArea,
  ConventionCorpus,
  ConventionCoverage,
  ConventionMap,
  ConventionMatch,
  ConventionOptions,
  ConventionQueryResult,
  ConventionSymbol,
  FindConventionsOptions,
  SummarizeConventionsResult,
  Summarizer,
} from "./conventions/types.js";
export { detectCommunities } from "./conventions/communities.js";
export { buildConventionAreas, defaultTargetCount } from "./conventions/areas.js";
export { COMMUNITY_SUMMARY_NAMESPACE, getConventionMap, summarizeConventions } from "./conventions/summaries.js";
export { findConventions } from "./conventions/query.js";
