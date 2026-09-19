import { z } from "zod";
import { MetricDescriptor, MissingReason, NodeRef, SnapshotRef } from "./schemas.js";

/** The row cap on `hierarchy.get`; past it the result says `truncated` and the shallowest rows are kept. */
export const HIERARCHY_ROW_CAP = 5_000;

const MetricNames = z.array(z.string().min(1)).max(40);

/** Present only with a baseline: the baseline's id, and false when its index version differs, so deltas may compare unlike measures. */
const BaselineFields = {
  baselineSnapshotId: z.number().int().optional(),
  comparable: z.boolean().optional(),
};

const hierarchyArgs = z.object({
  snapshot: SnapshotRef.optional(),
  root: z.string().optional(),
  depth: z.number().int().min(1).max(8).default(2),
  metrics: MetricNames.default(["loc"]),
  baseline: SnapshotRef.optional(),
  include_symbols: z.boolean().default(false),
  exclude_roles: z.array(z.string()).default([]),
});

const HierarchyRow = NodeRef.extend({
  parentId: z.string().nullable(),
  /** Relative to the requested root, which is 0. */
  depth: z.number().int(),
  /** Children in the full tree, symbols included, whatever `depth` and `include_symbols` returned. */
  childCount: z.number().int(),
  role: z.string().optional(),
  values: z.record(z.string(), z.number().nullable()),
  missing: z.record(z.string(), MissingReason).optional(),
  deltas: z.record(z.string(), z.number().nullable()).optional(),
});

const hierarchyResult = z.object({
  snapshotId: z.number().int(),
  ...BaselineFields,
  nodes: z.array(HierarchyRow),
  truncated: z.boolean(),
});

export const HIERARCHY_GET = {
  description:
    "A subtree of the synthesized repo, directory, file, and symbol hierarchy as a flat list with parent ids, " +
    "shallowest first. Directory values roll up per the metric catalogue; a null value says why in `missing`.",
  args: hierarchyArgs,
  result: hierarchyResult,
} as const;

const nodeGetArgs = z.object({
  snapshot: SnapshotRef.optional(),
  id: z.string(),
  baseline: SnapshotRef.optional(),
  metrics: MetricNames.default([]),
});

const NodeMetric = z.object({
  name: z.string(),
  unit: z.string().nullable(),
  direction: MetricDescriptor.shape.direction,
  rollup: MetricDescriptor.shape.rollup,
  value: z.number().nullable(),
  missing: MissingReason.optional(),
  percentile: z.number().nullable(),
  siblingMedian: z.number().nullable(),
  siblingRank: z.number().int().nullable(),
  siblingCount: z.number().int(),
  baseline: z.number().nullable().optional(),
  delta: z.number().nullable().optional(),
});

const nodeGetResult = z.object({
  snapshotId: z.number().int(),
  ...BaselineFields,
  node: NodeRef.extend({
    language: z.string().optional(),
    role: z.string().optional(),
    exported: z.boolean().optional(),
    signature: z.string().optional(),
    purpose: z.string().optional(),
  }),
  ancestors: z.array(NodeRef),
  childCounts: z.record(z.string(), z.number().int()),
  metrics: z.array(NodeMetric),
});

export const NODE_GET = {
  description:
    "One node by id (a directory id ends in '/', the repo is ''): its containing chain, child counts, and each metric " +
    "with direction, percentile among same-kind nodes, sibling median and rank, and a delta against an optional baseline.",
  args: nodeGetArgs,
  result: nodeGetResult,
} as const;

const nodeResolveArgs = z.object({
  snapshot: SnapshotRef.optional(),
  query: z.string().min(1).optional(),
  path: z.string().min(1).optional(),
  line: z.number().int().min(1).optional(),
  limit: z.number().int().min(1).max(50).default(10),
});

const nodeResolveResult = z.object({
  candidates: z.array(
    z.object({
      node: NodeRef,
      score: z.number(),
      /** Open string: "exact" | "span" | "suffix" | "prefix" | "substring" today. */
      match: z.string(),
    }),
  ),
});

export const NODE_RESOLVE = {
  description:
    "Turn a loose reference into ranked candidate node ids. Pass exactly one of `query` (a path, path:line, symbol name, " +
    "or file#Scope.name) or `path` with an optional `line`; a line resolves to the innermost symbol whose span contains it.",
  args: nodeResolveArgs,
  result: nodeResolveResult,
} as const;
