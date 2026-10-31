import type { AgentRow } from "@titan-design/agent-dispatch";
import type { Logger } from "@titan-design/daemon";
import type { GitHubPort } from "@titan-design/github";
import type { GateRecord } from "@titan-design/hitl";
import type { ReadTimer } from "./bounded.js";
import type { FreezeStoreRef } from "./freeze.js";
import type { GhGateway } from "./gh-gateway-port.js";
import type { MergeOrder, MergeOrderRules, OrderWaits, RunHolds } from "./merge-order.js";
import type { PrFilesRead } from "./git-pr-files.js";
import type { SeatBook } from "./seats.js";
import type { ReviewSlots } from "./review-slots.js";
import type { ShepherdStoreRef } from "./store.js";
import type { MergeTrainRef } from "./train.js";
import type { SnapshotServices } from "./snapshot-reads.js";
import type { VisualThreshold } from "./visual-threshold.js";

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
  /** Where `head-regression` lines go; absent means the daemon log. */
  headLog?: (line: string) => void;
  /** Arms each resync PR read's deadline; absent means the wall clock. */
  readTimer?: ReadTimer;
  /** Serve's GitHub gateway behind `shepherd.ghRead` and `shepherd.ghBudget`; absent on a host that is not serve. */
  gateway?: GhGateway;
  /** The spawn gate's last reviewer reading, reported in `/health`; absent on a host with no gate. */
  reviewSlots?: () => ReviewSlots | undefined;
  /** `shepherd.visualDelivery` on or in shadow; absent means serve starts no delivery sweep. */
  visualDelivery?: VisualDeliveryWatch;
  /** Where `shepherd thaw` alerts, by the main CI watch's red-event route; absent means each thaw only logs its alert. */
  thawAlert?: ThawAlertPorts;
  /** agent-chat's roster, which a retire-agent op's read-back reads; absent means that read-back answers unavailable. */
  roster?: { rows(): Promise<readonly AgentRow[]> };
  /** Merge-order reservations and the waits the merge guard read last; absent means `shepherd order` refuses and status shows neither. */
  mergeOrder?: MergeOrderServices;
  /** `shepherd.visualThreshold` for a repo, which `shepherd visual-delta` measures under; absent means that command refuses. */
  visualThreshold?: (repo: string) => VisualThreshold | undefined;
  /** Reads a task's title and done_when for `shepherd brief`; absent means the active-work daemon at its loopback origin. */
  tasks?: (slug: string, id: string) => Promise<{ title: string; done_when: string }>;
}

export interface MergeOrderServices {
  order: () => MergeOrder;
  holds: () => RunHolds;
  rules: MergeOrderRules;
  waits: OrderWaits;
  now: () => number;
}

/** The main CI watch's ports, described by shape here so this file stays a leaf. */
export interface ThawAlertPorts {
  hubSeat(): string | undefined;
  redSeat?(repo: string): string | undefined;
  send(seat: string, text: string): Promise<void>;
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
