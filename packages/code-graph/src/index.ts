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
export { DOMAIN_DDL, KIT, MIGRATIONS } from "./schema.js";

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
export { buildAliases, detectGitHead, detectGitToplevel, detectRenames, isInsideGitRepo } from "./git-renames.js";
export { computeMetrics } from "./metrics.js";
export { computeSourceMetrics, SOURCE_METRIC_NAMES } from "./source-metrics.js";
export { buildIndexerMetrics } from "./index-metrics.js";

/** Convenience readers over one snapshot; the store carries the full query surface. */
export { listEdges, listMetrics, listNodes } from "./read.js";

export type {
  CheckResult,
  CheckRule,
  CheckRulesFile,
  CheckViolation,
  ForbidImportRule,
  LayeredDepsRule,
  MetricMaxRule,
  MetricMinRule,
  MetricProductMaxRule,
  NoInternalOnlyBarrelsRule,
  Severity,
} from "./check/types.js";
export type { RunChecksOptions } from "./check/check.js";
export { runChecks } from "./check/check.js";
export type { ValidateRulesOptions } from "./check/validate.js";
export { validateRules } from "./check/validate.js";
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
