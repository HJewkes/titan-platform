import { isoWeek } from "../shepherd/stats.js";

/*
 * Back-pressure (operating model PROPOSAL 2.3, TP-5453 P4b): a lane admits new work only while it can land it.
 * Pure: lane-signals.ts reads the signals from the factory's own stores, and this file judges them against the limits.
 */

export interface BackPressureLimits {
  /** Work in flight (unmerged PRs plus merged ones not yet deployed) at which the lane admits no new spawn. */
  laneOpenPrs: number;
  /** Owner-queue items above which no gate-creating task is dispatched. */
  ownerQueue: number;
  /** Complete weeks in a row of task inflow above outflow that pause agent filing in the lane; reported, not enforced. */
  inflowWeeks: number;
}

/** The owner's starting values (2026-11-12); an absent config key means its value here. */
export const DEFAULT_LIMITS: BackPressureLimits = { laneOpenPrs: 3, ownerQueue: 10, inflowWeeks: 2 };

/** The signals a lane is judged on; a signal its source could not answer is absent and named in `unread`. */
export interface LaneSignals {
  /** Registered PRs of the lane's tasks whose Shepherd run has not finished. */
  openPrs?: number;
  /** Lane PRs whose run merged no earlier than the oldest commit the running factory build lacks. */
  mergedNotDeployed?: number;
  ownerQueue?: number;
  reviewers?: { accounts: number; exhausted: number };
  /** The deploy alarm's causes; empty while the deploy is healthy. */
  deployStall?: readonly string[];
  /** Repos whose main is frozen red. */
  redMain?: readonly string[];
  unread: Readonly<Partial<Record<SignalName, string>>>;
}

/** `deploy` unread also leaves `mergedNotDeployed` and `deployStall` absent: both are judged from the deploy reading. */
export type SignalName = "openPrs" | "ownerQueue" | "reviewers" | "deploy" | "redMain";

type HoldCode = "lane-open-prs" | "merged-not-deployed" | "owner-queue" | "reviewer-limit" | "dependency-stalled" | "signal-unreadable";

interface Hold {
  code: HoldCode;
  /** `lane` holds every spawn in the lane; `gate-creating` holds only tasks that list owner steps. */
  scope: "lane" | "gate-creating";
  numbers: Record<string, number>;
  detail: string;
}

export interface Admission {
  decision: "admit" | "hold";
  holds: Hold[];
}

function prHolds(signals: LaneSignals, limit: number): Hold[] {
  if (signals.openPrs === undefined) return [];
  const merged = signals.mergedNotDeployed ?? 0;
  const numbers = { open: signals.openPrs, mergedNotDeployed: merged, limit };
  if (signals.openPrs >= limit) return [{ code: "lane-open-prs", scope: "lane", numbers, detail: `${signals.openPrs} unmerged PR(s) at a limit of ${limit}` }];
  if (signals.openPrs + merged >= limit) {
    return [{ code: "merged-not-deployed", scope: "lane", numbers, detail: `${signals.openPrs} unmerged and ${merged} merged-not-deployed PR(s) at a limit of ${limit}` }];
  }
  return [];
}

function ownerQueueHolds(count: number | undefined, limit: number): Hold[] {
  if (count === undefined || count <= limit) return [];
  return [{ code: "owner-queue", scope: "gate-creating", numbers: { items: count, limit }, detail: `${count} owner-queue item(s) above a limit of ${limit}` }];
}

function reviewerHolds(reviewers: LaneSignals["reviewers"]): Hold[] {
  if (reviewers === undefined || reviewers.exhausted < reviewers.accounts) return [];
  return [{ code: "reviewer-limit", scope: "lane", numbers: { ...reviewers }, detail: `all ${reviewers.accounts} reviewer account(s) are at their usage limit` }];
}

/** No structured lane-to-component mapping exists, so a stall holds every lane (fails closed). */
function dependencyHolds(signals: LaneSignals): Hold[] {
  const causes = signals.deployStall?.length ?? 0;
  const red = signals.redMain?.length ?? 0;
  if (causes === 0 && red === 0) return [];
  const detail = [causes > 0 ? `deploy alarm (${causes} cause(s))` : "", red > 0 ? `red main in ${red} repo(s)` : ""].filter(Boolean).join(", ");
  return [{ code: "dependency-stalled", scope: "lane", numbers: { deployCauses: causes, redMainRepos: red }, detail: `${detail}; no lane-to-component mapping, so every lane holds` }];
}

/** A signal nobody could read holds what it guards, so an outage never reads as headroom. */
function unreadHolds(unread: LaneSignals["unread"]): Hold[] {
  return Object.entries(unread).map(([signal, why]) => ({
    code: "signal-unreadable" as const,
    scope: signal === "ownerQueue" ? ("gate-creating" as const) : ("lane" as const),
    numbers: {},
    detail: `${signal}: ${why}`,
  }));
}

/** Admit or hold the lane, with every hold that applies and the numbers behind it. */
export function admitLane(signals: LaneSignals, limits: BackPressureLimits): Admission {
  const holds = [
    ...prHolds(signals, limits.laneOpenPrs),
    ...ownerQueueHolds(signals.ownerQueue, limits.ownerQueue),
    ...reviewerHolds(signals.reviewers),
    ...dependencyHolds(signals),
    ...unreadHolds(signals.unread),
  ];
  return { decision: holds.some((hold) => hold.scope === "lane") ? "hold" : "admit", holds };
}

/** The holds that keep one task back: every lane hold, and gate-creating holds when the task lists owner steps. */
export function holdsFor(admission: Admission, ownerSteps: readonly unknown[] | undefined): Hold[] {
  const gateCreating = (ownerSteps?.length ?? 0) > 0;
  return admission.holds.filter((hold) => hold.scope === "lane" || gateCreating);
}

export interface LaneTask {
  created: string;
  doneAt: string | null;
}

interface FlowWeek {
  week: string;
  inflow: number;
  outflow: number;
}

export interface Filing {
  /** True when every one of the last `weeks` complete ISO weeks had inflow above outflow. */
  paused: boolean;
  weeks: FlowWeek[];
}

const WEEK_MS = 7 * 24 * 60 * 60_000;

const weekOf = (date: string | null): string | undefined => {
  const at = date === null ? Number.NaN : Date.parse(date);
  return Number.isNaN(at) ? undefined : isoWeek(at);
};

/** Tasks created against tasks done in each of the `count` complete ISO weeks before `now`'s, oldest first. */
export function filingFlow(tasks: readonly LaneTask[], now: number, count: number): Filing {
  const weeks = Array.from({ length: count }, (_, at) => isoWeek(now - (count - at) * WEEK_MS));
  const flow = weeks.map((week) => ({
    week,
    inflow: tasks.filter((task) => weekOf(task.created) === week).length,
    outflow: tasks.filter((task) => weekOf(task.doneAt) === week).length,
  }));
  return { paused: flow.length > 0 && flow.every((week) => week.inflow > week.outflow), weeks: flow };
}
