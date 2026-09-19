import { z } from "zod";
import { NodeRef, Provenance, ProvenanceKind, Severity, SnapshotRef, Span } from "./schemas.js";

/** Most rows one `findings.list` page returns; a table pages with `offset`. */
export const FINDINGS_PAGE_MAX = 500;

/** Most lines one excerpt carries, whatever the flagged range and context ask for. */
export const EXCERPT_LINE_CAP = 80;

export const FindingStatus = z.enum(["new", "carryover", "resolved", "worsened", "improved"]);

const BaselineFields = {
  baselineSnapshotId: z.number().int().optional(),
  comparable: z.boolean().optional(),
};

export const Finding = z.object({
  /** Opaque and stable across snapshots while the rule, node, and destination are unchanged. */
  id: z.string(),
  snapshotId: z.number().int(),
  rule: z.string(),
  /** Open string: "check" for check-rule findings today. */
  tool: z.string(),
  severity: Severity,
  node: NodeRef,
  destination: NodeRef.optional(),
  /** The first flagged line range; absent when the finding is about the whole node. */
  range: Span.optional(),
  metric: z.string().optional(),
  value: z.number().optional(),
  threshold: z.number().optional(),
  /** How far past the threshold, as a ratio where larger is worse; null when the rule has no threshold. */
  excess: z.number().nullable(),
  /** Present only when a baseline was given. */
  status: FindingStatus.optional(),
  message: z.string(),
  provenance: Provenance,
});

const findingsListArgs = z.object({
  snapshot: SnapshotRef.optional(),
  baseline: SnapshotRef.optional(),
  scope: z.string().optional(),
  rule: z.array(z.string()).default([]),
  severity: z.array(Severity).default([]),
  tool: z.array(z.string()).default([]),
  provenance: z.array(ProvenanceKind).default([]),
  kind: z.array(z.string()).default([]),
  status: z.array(FindingStatus).default([]),
  sort: z.enum(["severity", "excess", "value", "path", "rule"]).default("severity"),
  order: z.enum(["asc", "desc"]).default("desc"),
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(0).max(FINDINGS_PAGE_MAX).default(20),
  facets: z.boolean().default(false),
});

const findingsListResult = z.object({
  snapshotId: z.number().int(),
  ...BaselineFields,
  rows: z.array(Finding),
  total: z.number().int(),
  /** Facet name to value to count, over every row that passed the filters; each facet's counts sum to `total`. */
  facets: z.record(z.string(), z.record(z.string(), z.number().int())).optional(),
});

export const FINDINGS_LIST = {
  description:
    "Findings in a snapshot, filtered, sorted, and offset-paginated, with optional facet counts. Check-rule findings are " +
    "derived on read (provenance 'derived'), so one disappears when its rule or threshold changes. `scope` limits to a node " +
    "and everything under it. With `baseline`, each row gets a status and resolved findings come back from the baseline.",
  args: findingsListArgs,
  result: findingsListResult,
} as const;

export const SourceExcerpt = z.object({
  path: z.string(),
  startLine: z.number().int(),
  endLine: z.number().int(),
  text: z.string(),
  /** Of the whole file at the snapshot. */
  contentHash: z.string(),
  origin: z.enum(["commit", "worktree", "export"]),
  highlights: z.array(Span),
  /** True when the cap cut the requested window short. */
  truncated: z.boolean(),
});

const findingGetArgs = z.object({
  snapshot: SnapshotRef.optional(),
  id: z.string(),
  baseline: SnapshotRef.optional(),
  context_lines: z.number().int().min(0).max(20).default(5),
});

const findingGetResult = z.object({
  snapshotId: z.number().int(),
  ...BaselineFields,
  finding: Finding,
  rule: z.object({ id: z.string(), type: z.string(), severity: Severity, text: z.string() }),
  measured: z.object({
    value: z.number().nullable(),
    threshold: z.number().nullable(),
    percentile: z.number().nullable(),
    siblingMedian: z.number().nullable(),
    baselineValue: z.number().nullable().optional(),
  }),
  why: z.string(),
  excerpt: SourceExcerpt.nullable(),
  /** Open string: why `excerpt` is null, such as "no-source" or "changed-since-snapshot". */
  excerptMissing: z.string().optional(),
  related: z.array(Finding),
});

export const FINDING_GET = {
  description:
    "One finding by id with its rule, the measured value in context, a source excerpt of the flagged lines plus " +
    "`context_lines` either side, and up to 10 related findings on the same node or on graph neighbours.",
  args: findingGetArgs,
  result: findingGetResult,
} as const;

const nodeNeighborsArgs = z.object({
  snapshot: SnapshotRef.optional(),
  id: z.string(),
  direction: z.enum(["in", "out", "both"]).default("both"),
  edge_kinds: z.array(z.string()).default([]),
  metrics: z.array(z.string().min(1)).max(10).default(["loc", "utilization"]),
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(100).default(20),
});

const Neighbor = z.object({
  node: NodeRef,
  kind: z.string(),
  weight: z.number().nullable(),
  specifier: z.string().optional(),
  values: z.record(z.string(), z.number().nullable()),
});

const nodeNeighborsResult = z.object({
  snapshotId: z.number().int(),
  node: NodeRef,
  inbound: z.array(Neighbor),
  outbound: z.array(Neighbor),
  /** Edges in each direction before `offset` and `limit`; zero for a direction not asked for. */
  total: z.object({ inbound: z.number().int(), outbound: z.number().int() }),
});

export const NODE_NEIGHBORS = {
  description:
    "Edges into and out of one stored node (file, symbol, module, or external), heaviest first, each with the neighbour's " +
    "metric values. Empty `edge_kinds` means every kind except 'references' unless the node is a symbol.",
  args: nodeNeighborsArgs,
  result: nodeNeighborsResult,
} as const;

export type Finding = z.infer<typeof Finding>;
export type FindingStatus = z.infer<typeof FindingStatus>;
export type SourceExcerpt = z.infer<typeof SourceExcerpt>;
