import type { SnapshotRow } from "../types.js";
import type { PartitionQualityResult } from "./partition-quality.js";

/** A top-level sub-directory of a drilled package, rendered inside its cluster. */
export interface ArchSubNode {
  /** Full path id, e.g. "packages/cli/src/commands". */
  id: string;
  /** Directory name shown as the node label, e.g. "commands". */
  label: string;
  files: number;
}

export interface ArchPackage {
  id: string;
  name: string;
  files: number;
  /** Present when the package was drilled (--depth modules); renders as a subgraph. */
  subNodes?: ArchSubNode[];
}

export interface ArchEdge {
  from: string;
  to: string;
  count: number;
}

// codewatch's domains and split diagnostics stay CLI-side, so the result carrying them
// extends this one there.
export interface ArchResult {
  snapshot: SnapshotRow;
  packages: ArchPackage[];
  edges: ArchEdge[];
  includesExternal: boolean;
  /** Present when options.health=true. */
  quality?: PartitionQualityResult;
}
