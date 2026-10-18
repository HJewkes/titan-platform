import type { Logger } from "@titan-design/daemon";
import type { GitHubPort } from "@titan-design/github";
import type { GateRecord } from "@titan-design/hitl";
import type { FreezeStoreRef } from "./freeze.js";
import type { GhGateway } from "./gh-gateway-port.js";
import type { PrFilesRead } from "./git-pr-files.js";
import type { SeatBook } from "./seats.js";
import type { ReviewSlots } from "./review-slots.js";
import type { KindGuard } from "./register-kind.js";
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
  /** The spawn gate's last reviewer reading, reported in `/health`; absent on a host with no gate. */
  reviewSlots?: () => ReviewSlots | undefined;
  /** Replaces `kindMoveRefusal` at register; a test runs the guard as it reads once TEST_ONLY_GATED is gone (TP-2732 f deletes both). */
  kindGuard?: KindGuard;
  /** `shepherd.visualDelivery` on or in shadow; absent means serve starts no delivery sweep. */
  visualDelivery?: VisualDeliveryWatch;
}

/** Serve's pending gates, and one gate read afresh, for a sweep that must not import the host. */
export interface GateReads {
  pendingGates(): readonly { runId: string; stepId: string; gate: GateRecord }[];
  gate(id: string): GateRecord | undefined;
}

/** What health shows, as gateNotify shows `stuck`: a pending visual gate whose delivery failed waits on the coordinator's hand flow. */
interface VisualDeliveryStatus {
  waiting: number;
  failed: { gateId: string; reason: string }[];
}

/** `src/shepherd/visual-delivery-sweep.ts`'s watch, described by shape here so this file stays a leaf. */
export interface VisualDeliveryWatch {
  everyMs: number;
  tick(gates: GateReads, services: ShepherdServices, log: Logger, signal: AbortSignal): Promise<void>;
  status(): VisualDeliveryStatus;
}
