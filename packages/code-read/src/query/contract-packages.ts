import { z } from "zod";
import { SnapshotRef } from "./schemas.js";

/** Most package roots one `packages.stats` call takes. */
export const PACKAGES_MAX = 500;

/** The package's tier in a `layered-deps` rule, 0 the lowest; a package no such rule names is `undeclared`. */
export const PackageLayer = z.discriminatedUnion("status", [
  z.object({ status: z.literal("declared"), tier: z.number().int(), rule: z.string() }),
  z.object({ status: z.literal("undeclared") }),
]);

export const PackageStatsRow = z.object({
  /** The package root, a repo-relative path prefix such as `packages/cli`. */
  id: z.string(),
  /** The root's last path segment; the index holds no package manifests. */
  name: z.string(),
  fileCount: z.number().int(),
  internalEdges: z.number().int(),
  outgoingEdges: z.number().int(),
  incomingEdges: z.number().int(),
  /** internal / (internal + outgoing); 0 with neither. */
  cohesion: z.number(),
  /** outgoing / (outgoing + incoming), Martin's I; 0 with neither. */
  instability: z.number(),
  /** Share of the package's files with role "types", a stand-in for Martin's A. */
  abstractness: z.number(),
  /** code-graph's instability band: at most 0.3 foundation, at least 0.9 top. Measured, unlike `layer`. */
  band: z.enum(["foundation", "middle", "top"]),
  /** Open string: "weak-boundary" today. */
  flags: z.array(z.string()),
  layer: PackageLayer,
});

/** Edges from one package into another, with their share of the source package's files. */
export const CrossEdge = z.object({
  from: z.string(),
  to: z.string(),
  edges: z.number().int(),
  /** edges / files(from). */
  intensity: z.number(),
  /** At least 0.6 tight, at least 0.3 moderate. */
  flag: z.enum(["tight", "moderate", "none"]),
});

const packagesStatsArgs = z.object({
  snapshot: SnapshotRef.optional(),
  /** Package roots as repo-relative path prefixes; omitted means every package the tier config declares. */
  packages: z.array(z.string().min(1)).max(PACKAGES_MAX).optional(),
});

const packagesStatsResult = z.object({
  snapshotId: z.number().int(),
  /** Where the package roots came from: the `packages` argument, or the `layered-deps` rules; `none` when neither names one. */
  packagesFrom: z.enum(["args", "tiers", "none"]),
  /** Newman-Girvan modularity Q of the package partition; 0 with no edges. */
  modularity: z.number(),
  /** File-to-file edges with both ends in a package, internal and cross. */
  totalEdges: z.number().int(),
  /** Files counted under no package root. */
  unassignedFiles: z.number().int(),
  /** One row per package root, by id. */
  packages: z.array(PackageStatsRow),
  /** By `from`, then `to`. */
  crossEdges: z.array(CrossEdge),
});

export const PACKAGES_STATS = {
  description:
    "Package structure for a snapshot: per package its file count, internal, outgoing, and incoming edges, cohesion, " +
    "instability, abstractness, and its tier in the repo's layered-deps rules, plus the package-to-package edges and the " +
    "snapshot's modularity. Test and fixture files are left out, as code-graph's arch view leaves them out. A package no " +
    "tier names has layer status 'undeclared'.",
  args: packagesStatsArgs,
  result: packagesStatsResult,
} as const;

export type PackageLayer = z.infer<typeof PackageLayer>;
export type PackageStatsRow = z.infer<typeof PackageStatsRow>;
export type CrossEdge = z.infer<typeof CrossEdge>;
