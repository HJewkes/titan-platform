import type { GitHubPort } from "@titan-design/github";
import type { FreezeStoreRef } from "./freeze.js";
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
}
