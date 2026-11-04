import type { DigestItem, LaneRole } from "../../digest.js";
import type { Lane, LanesFile, RankKey } from "../../lanes-schema.js";
import type { DayWindow } from "./session-source.js";
import type { SnapshotTask } from "./task-snapshot.js";

/** A merged PR placed in one lane, with the task its title names when the task list holds it. */
export interface LanedPr {
  item: DigestItem;
  lane: string;
  role: LaneRole;
  goal?: string;
  task?: SnapshotTask;
}

/** The PRs of one lane that share a task, or a lone PR whose title names none. */
export interface Thread {
  id: string;
  lane: string;
  role: LaneRole;
  goal?: string;
  task?: SnapshotTask;
  /** The task closed inside the window. */
  closed: boolean;
  prs: DigestItem[];
}

const TASK_ID = /\b[A-Z][A-Z0-9]*-\d+\b/;
const SEAT_BRANCH = /^agent-chat\/([a-z0-9]+)-/;

export const taskIdOf = (title: string): string | undefined => title.match(TASK_ID)?.[0];

function laneByPaths(packages: readonly string[], lanes: readonly Lane[]): string | undefined {
  let best: { id: string; hits: number } | undefined;
  for (const lane of lanes) {
    const hits = packages.filter((pkg) => lane.paths.some((prefix) => pkg.startsWith(prefix))).length;
    if (hits > (best?.hits ?? 0)) best = { id: lane.id, hits };
  }
  return best?.id;
}

/** Seat first (who did the work), then the repo's own lane, then the lane holding most of its packages. */
export function laneOf(item: DigestItem, file: LanesFile): string {
  const seat = item.branch?.match(SEAT_BRANCH)?.[1];
  const bySeat = seat === undefined ? undefined : file.lanes.find((lane) => lane.seats.includes(seat));
  const byRepo = file.lanes.find((lane) => item.repo !== undefined && lane.repos.includes(item.repo));
  return bySeat?.id ?? byRepo?.id ?? laneByPaths(item.packages ?? [], file.lanes) ?? file.fallback;
}

function roleOf(task: SnapshotTask | undefined, lane: Lane, file: LanesFile): Pick<LanedPr, "role" | "goal"> {
  const tags = new Set(task?.tags ?? []);
  if (file.sideQuestTags.some((tag) => tags.has(tag))) return { role: "side-quest" };
  const goal = lane.goals.find((row) => row.tags.some((tag) => tags.has(tag)));
  return goal ? { role: "goal", goal: goal.id } : { role: "other" };
}

/** Every merged PR in `items`, each in exactly one lane. */
export function attributeLanes(items: readonly DigestItem[], tasks: readonly SnapshotTask[], file: LanesFile): LanedPr[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  return items.filter((item) => item.kind === "pull-request" && item.change === "merged").map((item) => {
    const lane = file.lanes.find((row) => row.id === laneOf(item, file))!;
    const taskId = taskIdOf(item.title);
    const task = taskId === undefined ? undefined : byId.get(taskId);
    return { item, lane: lane.id, ...roleOf(task, lane, file), ...(task ? { task } : {}) };
  });
}

const closedIn = (task: SnapshotTask | undefined, window: DayWindow): boolean => {
  const at = task?.status === "done" && task.done_at ? Date.parse(task.done_at) : Number.NaN;
  return at >= Date.parse(window.since) && at < Date.parse(window.until);
};

/** Groups each lane's PRs by the task their titles name; a PR naming no task is a thread of its own. */
export function threadsOf(laned: readonly LanedPr[], window: DayWindow): Thread[] {
  const threads = new Map<string, Thread>();
  for (const pr of laned) {
    const key = `${pr.lane}/${taskIdOf(pr.item.title) ?? pr.item.id}`;
    const thread = threads.get(key);
    if (thread) thread.prs.push(pr.item);
    else threads.set(key, { id: key, lane: pr.lane, role: pr.role, ...(pr.goal ? { goal: pr.goal } : {}), ...(pr.task ? { task: pr.task } : {}), closed: closedIn(pr.task, window), prs: [pr.item] });
  }
  return [...threads.values()];
}

const ROLE_ORDER: Record<LaneRole, number> = { goal: 0, other: 1, "side-quest": 2 };
const SEVERITY_ORDER: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };
const linesOf = (thread: Thread) => thread.prs.reduce((sum, pr) => sum + (pr.size ?? 0), 0);

// Each key is ascending in "comes first": a lower number ranks higher.
const RANK: Record<RankKey, (thread: Thread) => number> = {
  role: (thread) => ROLE_ORDER[thread.role],
  closed: (thread) => (thread.closed ? 0 : 1),
  estimate: (thread) => -(thread.task?.estimate ?? 0),
  severity: (thread) => -(SEVERITY_ORDER[thread.task?.severity ?? ""] ?? 0),
  prs: (thread) => -thread.prs.length,
  size: (thread) => -linesOf(thread),
};

/** Most consequential first, by the rule file's keys in order; the thread id settles a full tie. */
export function rankThreads(threads: readonly Thread[], keys: readonly RankKey[]): Thread[] {
  return [...threads].sort((a, b) => {
    for (const key of keys) {
      const diff = RANK[key](a) - RANK[key](b);
      if (diff !== 0) return diff;
    }
    return a.id.localeCompare(b.id);
  });
}

/** How many threads a lane names: its share of the lanes block, floored, in thread-sized slots, clamped. */
export function namedCount(laneMerged: number, totalMerged: number, named: LanesFile["named"]): number {
  const laneSeconds = Math.max(named.laneFloorS, totalMerged === 0 ? 0 : (named.lanesBlockS * laneMerged) / totalMerged);
  return Math.min(named.max, Math.max(named.min, Math.round(laneSeconds / named.secondsPerThread)));
}
