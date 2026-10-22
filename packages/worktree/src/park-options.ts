import type { WorktreeOptions } from "./options.js";
import type { ParkIgnoredFilesPolicy } from "./park-ignored-files.js";
import type { ParkLocalBackingReader } from "./park-local-backing.js";

/** Parking keeps the local branch; an opt-in fresh default proof can establish its commits are already backed. */
export interface ParkOptions {
  /** Lazy caller-supplied local commit backing; requires allowOriginHeadAncestor strictly true. */
  localBackingCandidates?: ParkLocalBackingReader;
  /** Explicit policy over fresh ignored files only; dirty status and failed observations always refuse. */
  ignoredFiles?: ParkIgnoredFilesPolicy;
  /** Retain the actual branch when tracking or a fresh origin-head ancestry proof backs its HEAD. */
  allowOriginHeadAncestor?: boolean;
  /** Permit a missing origin/branch only when a fresh DEFAULT fetch contains the actual HEAD. */
  allowDefaultBranchAncestor?: boolean;
  /** Positive finite fetch budget; invalid values refuse without fetching. Defaults to 15 seconds. */
  fetchTimeoutMs?: WorktreeOptions["fetchTimeoutMs"];
}

