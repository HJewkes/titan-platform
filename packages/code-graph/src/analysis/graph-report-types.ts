import type { ChurnWindow } from "../history/window.js";
import type { SnapshotRow } from "../types.js";

export interface HotspotRow {
  nodeId: string;
  churn: number;
  complexity: number;
  /** Shown beside complexity: complexity alone mostly restates file size. */
  loc: number;
  score: number;
  /** Age-recency factor applied to the score (1 = no discount); see recency_{window}d. */
  recency: number;
}

export interface NewHotspot extends HotspotRow {
  /**
   * Baseline hotspot score if the file existed in the baseline snapshot;
   * `undefined` ⇒ a newborn file (didn't exist at baseline). Lets the UI split
   * "new file" (neutral) from "existing file that climbed into the ranking".
   */
  before?: number;
}

export interface BusFactorRow {
  nodeId: string;
  busFactor: number;
  topAuthorShare: number;
  churn: number;
}

export interface CouplingRow {
  fileA: string;
  fileB: string;
  count: number;
}

export interface CentralRow {
  nodeId: string;
  score: number;
}

export interface UnusedExportRow {
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

export interface DeadModuleRow {
  /** The unreferenced file's node id. */
  nodeId: string;
  /** Its size, for ranking (a large dead file is the most worth removing). */
  loc: number;
  /** Its role (usually "source" or "types"). */
  role: string;
}

export interface GrowthRiskRow {
  nodeId: string;
  /** Max lexical loop-nesting depth (C-66); 0 when the file's smell is not nesting. */
  loopDepth: number;
  /** Human-readable scaling smells (deep loops, recursion, linear-search-in-loop). */
  smells: string[];
}

export interface UntestedRiskRow {
  nodeId: string;
  /** Coverage % from an ingested Istanbul report (C-63). */
  coverage: number;
  /** Hotspot score (churn × complexity × recency) for context. */
  hotspot: number;
  /** hotspot × (1 − coverage/100): load-bearing, complex, churning, AND untested. */
  score: number;
}

export interface TestCoverageRow {
  /** Source (non-test) file whose test coverage is owner-concentrated. */
  nodeId: string;
  /** Bus factor of the linked test files' authorship (1 = single owner). */
  testBusFactor: number;
  /** Share of test churn from the single largest test author (0..1). */
  testTopAuthorShare: number;
  /** How many distinct test files link to this source. */
  linkedTests: number;
}

export interface GraphReportResult {
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
}

export interface HotspotDelta {
  nodeId: string;
  before: number;
  after: number;
  delta: number;
}

export interface BusFactorChange {
  nodeId: string;
  churn: number;
}

export interface CouplingDelta {
  fileA: string;
  fileB: string;
  before: number;
  after: number;
}

export interface ReportDrift {
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
