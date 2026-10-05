// The "./analysis" subpath: report derivations a browser may import. Re-export only modules
// graph-report-browser-safe.test.ts checks, so the subpath never reaches the Node-only root.
export type {
  BusFactorChange,
  BusFactorRow,
  CentralRow,
  CouplingDelta,
  CouplingRow,
  DeadModuleRow,
  GraphReportResult,
  GrowthRiskRow,
  HotspotDelta,
  HotspotRow,
  NewHotspot,
  ReportDrift,
  TestCoverageRow,
  UnusedExportRow,
  UntestedRiskRow,
} from "./graph-report-types.js";
export type { ReportContext, ReportContextInput } from "./graph-report-sections.js";
export {
  buildReportContext,
  busFactorOf,
  hotspotScoreOf,
  keepNode,
  lookupMetric,
  topBusFactorRisks,
  topCentralFiles,
  topHotspots,
  topTestCoverageRisks,
} from "./graph-report-sections.js";
export { publicApiFiles, topUnusedExports } from "./unused-exports.js";
export { topDeadModules } from "./dead-modules.js";
export { topGrowthRisks } from "./growth-risks.js";
export { topUntestedRisks } from "./untested-risks.js";
export type { ComputeDriftInput } from "./graph-report-drift.js";
export { computeReportDrift } from "./graph-report-drift.js";
export type { HealthComponent } from "./dashboard-health.js";
export { computeHealth } from "./dashboard-health.js";
export type { BlastRadiusEntry, HotExport, NodeMetrics, SymbolUtil } from "./dashboard-node-metrics.js";
export {
  buildBlastRadius,
  buildCentralFiles,
  buildHotExports,
  buildNodeMetrics,
  collectNodeMetrics,
  collectSymbolUtil,
  referencedNodes,
} from "./dashboard-node-metrics.js";
export type { CouplingClass, SnapshotContext } from "./dashboard-coupling.js";
export { classifyCoupling, pairKey } from "./dashboard-coupling.js";
export type { PackageRoot } from "./package-buckets.js";
export { bucketFilesByPackage } from "./package-buckets.js";
export type { ArchEdge, ArchPackage, ArchResult, ArchSubNode } from "./graph-arch-types.js";
export type { ComputeArchInput } from "./graph-arch-compute.js";
export {
  DEFAULT_MAX_PACKAGE_SIZE,
  EXTERNAL_BUCKET,
  aggregateEdges,
  computeArch,
  filteredFileIds,
  packagesReferencedByEdges,
  toSortedEdges,
} from "./graph-arch-compute.js";
