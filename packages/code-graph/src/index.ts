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

export type { Extractor, ParsedFile } from "./parser/index.js";
export { getLanguageFromPath, getSupportedLanguages, parseFile, shouldIncludeFile } from "./parser/index.js";

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
