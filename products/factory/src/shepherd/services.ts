import type { GitHubPort } from "@titan-design/github";
import type { FreezeStoreRef } from "./freeze.js";
import type { GhGateway } from "./gh-gateway-port.js";
import type { PrFilesRead } from "./git-pr-files.js";
import type { SeatBook } from "./seats.js";
import type { ShepherdStoreRef } from "./store.js";
import type { MergeTrainRef } from "./train.js";
import type { SnapshotServices } from "./snapshot-reads.js";

export const SHEPHERD_WORKFLOW = "shepherd-pr";

/** What the shepherd commands read beyond the host; the route set that binds the store carries it. */
export interface ShepherdServices extends SnapshotServices {
  store: ShepherdStoreRef;
  port: GitHubPort;
  /** Read on every register, so a seat or deny change applies without a restart; an unreadable seat book refuses. */
  seats: () => SeatBook;
  /** Absent means no row reports a run waiting for its repo's merge train. */
  train?: MergeTrainRef;
  /** Read before a gate a freeze caused is superseded, and watched for thaws; absent means no repo is ever frozen. */
  freeze?: FreezeStoreRef;
  /** Reads a registered head's changed files from Shepherd's git cache; absent means the serve process's cached reader. */
  prFiles?: PrFilesRead;
  /** The clock `shepherd.prs` dates its merged window by; absent means the wall clock. */
  now?: () => number;
  /** Serve's GitHub gateway behind `shepherd.ghRead` and `shepherd.ghBudget`; absent on a host that is not serve. */
  gateway?: GhGateway;
}
