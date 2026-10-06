import {
  bucketFilesByPackage,
  computePartitionQuality,
  filteredFileIds,
  type PackageRoot,
  type PackageStats,
  type PartitionQualityInput,
} from "@titan-design/code-graph/analysis";
import type { CommandArgs, CommandResult } from "./contract.js";
import type { PackageLayer, PackageStatsRow } from "./contract-packages.js";
import { inputsFor } from "./hotspots.js";
import type { ModelRule, ReadModel } from "./model.js";
import { modelFor } from "./snapshot-ref.js";
import type { ReadSource } from "./source.js";

type StatsArgs = CommandArgs<"packages.stats">;
type StatsResult = CommandResult<"packages.stats">;
type Declared = Extract<PackageLayer, { status: "declared" }>;
type GraphEdgeLike = PartitionQualityInput["edges"][number];

// codewatch's arch view reads the store's default edge layer, which leaves these kinds out.
const NON_STRUCTURAL = new Set(["references", "calls"]);
const UNDECLARED: PackageLayer = { status: "undeclared" };

const trimRoot = (id: string): string => id.replace(/\/+$/, "");

/** Package root to its tier; a root two rules name keeps the first rule's tier. */
export function declaredTiers(rules: readonly ModelRule[]): Map<string, Declared> {
  const out = new Map<string, Declared>();
  for (const rule of rules) {
    rule.layers?.forEach((tier, i) => {
      for (const id of tier.map(trimRoot)) if (!out.has(id)) out.set(id, { status: "declared", tier: i, rule: rule.id });
    });
  }
  return out;
}

function packageRoots(args: StatsArgs, tiers: ReadonlyMap<string, Declared>): Pick<StatsResult, "packagesFrom"> & { roots: PackageRoot[] } {
  const ids = [...new Set((args.packages ?? [...tiers.keys()]).map(trimRoot))].filter((id) => id !== "").sort();
  const packagesFrom = args.packages ? "args" : ids.length > 0 ? "tiers" : "none";
  return { packagesFrom, roots: ids.map((id) => ({ id, name: id.slice(id.lastIndexOf("/") + 1) })) };
}

function structuralEdges(model: ReadModel): GraphEdgeLike[] {
  return model.edges
    .filter((e) => !NON_STRUCTURAL.has(e.kind))
    .map((e) => ({ srcId: e.srcId, dstId: e.dstId, kind: e.kind as GraphEdgeLike["kind"], attrs: e.attrs }));
}

function toRow(stats: PackageStats, name: string, layer: PackageLayer): PackageStatsRow {
  const { pkgId, layer: band, flags, ...measures } = stats;
  return { id: pkgId, name, ...measures, band, flags: [...flags], layer };
}

/** `packages.stats`: code-graph's partition quality over the package roots, each with its declared tier. */
export function packagesStats(source: ReadSource, args: StatsArgs): StatsResult {
  const model = modelFor(source, args.snapshot);
  const tiers = declaredTiers(model.rules);
  const { packagesFrom, roots } = packageRoots(args, tiers);
  const { nodes } = inputsFor(model);
  const fileByPackage = bucketFilesByPackage(filteredFileIds(nodes, {}), roots);
  const quality = computePartitionQuality({ packages: roots, fileByPackage, nodes, edges: structuralEdges(model) });
  const names = new Map(roots.map((r) => [r.id, r.name]));
  return {
    snapshotId: model.snapshot.id,
    packagesFrom,
    modularity: quality.modularityQ,
    totalEdges: quality.totalEdges,
    unassignedFiles: fileByPackage.get("")?.length ?? 0,
    packages: quality.perPackage.map((p) => toRow(p, names.get(p.pkgId)!, tiers.get(p.pkgId) ?? UNDECLARED)),
    crossEdges: quality.pairCoupling.map((c) => ({ ...c })),
  };
}
