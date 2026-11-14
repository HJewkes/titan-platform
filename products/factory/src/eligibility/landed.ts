import type { Task } from "@titan-design/pm";
import { isoWeek } from "../shepherd/stats.js";
import {
  filingFlow,
  type BackPressureLimits,
  type LaneSignals,
} from "./back-pressure.js";

/*
 * Landed means merged, deployed and switched on (operating model PROPOSAL 2.3, TP-5755 S5). back-pressure.ts counts the
 * first two; this file adds the third and the filing pause. Pure: landed-signals.ts reads the facts, and `admitLane` stays
 * untouched, so these holds compose beside it.
 */

type LandedCode = "merged-not-switched-on" | "filing-paused";

export interface LandedHold {
  task: string;
  stage: "admission";
  codes: LandedCode[];
  details: string[];
  numbers?: Record<string, number>;
}

/** A lane task as `readLaneTasks` reads it, with what the two rules judge. */
export interface LandedTask {
  /** `initiative/ID`. */
  key: string;
  status: string | undefined;
  source: string | undefined;
  created: string;
  doneAt: string | null;
  ownerSteps: readonly { kind: string }[];
}

/** The owner steps that leave a merged change not yet in use; a `sitting` is a meeting, not a switch-on. */
const SWITCH_ON_KINDS: ReadonlySet<string> = new Set([
  "restart",
  "config",
  "release",
  "publish",
  "credential",
]);

/** The sources an agent files; kept beside intake.ts's own list, which is not exported, and an owner's task is never one of them. */
const AGENT_FILED: ReadonlySet<string> = new Set([
  "follow-up",
  "review",
  "sweep",
  "audit",
  "coordinator",
]);

const awaitsSwitchOn = (task: LandedTask): boolean =>
  task.status === "open" &&
  task.ownerSteps.some((step) => SWITCH_ON_KINDS.has(step.kind));

/** Lane tasks whose PR merged but which still hold an owner step that turns the change on. */
export function mergedNotSwitchedOn(
  tasks: readonly LandedTask[],
  mergedTasks: ReadonlySet<string>
): number {
  return tasks.filter(
    (task) => mergedTasks.has(task.key) && awaitsSwitchOn(task)
  ).length;
}

interface LandedInput {
  initiative: string;
  /** The lane's eligible tasks in dispatch order. */
  eligible: readonly { task: Task }[];
  laneTasks: readonly LandedTask[];
  /** Task keys with a merged Shepherd outcome. */
  mergedTasks: ReadonlySet<string>;
  signals: LaneSignals;
  limits: BackPressureLimits;
  now: number;
}

/** Candidates past the slots the unswitched merges leave are held, in dispatch order, so the shadow never over-admits. */
function switchOnHolds(input: LandedInput): LandedHold[] {
  const { signals, limits } = input;
  const count = mergedNotSwitchedOn(input.laneTasks, input.mergedTasks);
  if (count === 0 || signals.openPrs === undefined) return [];
  const merged = signals.mergedNotDeployed ?? 0;
  const free = Math.max(
    0,
    limits.laneOpenPrs - signals.openPrs - merged - count
  );
  const numbers = {
    open: signals.openPrs,
    mergedNotDeployed: merged,
    mergedNotSwitchedOn: count,
    limit: limits.laneOpenPrs,
  };
  const detail = `${count} merged PR(s) still wait on an owner step to switch them on; ${signals.openPrs} unmerged and ${merged} merged-not-deployed at a limit of ${limits.laneOpenPrs}`;
  return input.eligible
    .slice(free)
    .map((entry) => ({
      task: `${input.initiative}/${entry.task.id}`,
      stage: "admission",
      codes: ["merged-not-switched-on"],
      details: [detail],
      numbers,
    }));
}

function filingHolds(input: LandedInput): LandedHold[] {
  const filing = filingFlow(
    input.laneTasks,
    input.now,
    input.limits.inflowWeeks
  );
  if (!filing.paused) return [];
  const weeks = new Set(filing.weeks.map((week) => week.week));
  const filedWhilePaused = new Set(
    input.laneTasks
      .filter(
        (task) =>
          task.source !== undefined &&
          AGENT_FILED.has(task.source) &&
          weeks.has(isoWeek(Date.parse(task.created)))
      )
      .map((task) => task.key)
  );
  const detail = `filing is paused: inflow exceeded outflow in each of the last ${input.limits.inflowWeeks} weeks, and this agent-filed task was created in one of them`;
  return input.eligible.flatMap((entry) => {
    const task = `${input.initiative}/${entry.task.id}`;
    return filedWhilePaused.has(task)
      ? [
          {
            task,
            stage: "admission" as const,
            codes: ["filing-paused" as const],
            details: [detail],
          },
        ]
      : [];
  });
}

export function landedRuleHolds(input: LandedInput): LandedHold[] {
  return [...switchOnHolds(input), ...filingHolds(input)];
}
