import type { DigestItem } from "../../digest.js";
import type { LanesFile } from "../../lanes-schema.js";
import type { DayWindow } from "./session-source.js";
import type { SnapshotTask } from "./task-snapshot.js";

/** Open tasks named per lane as the next priorities. */
export const PRIORITIES_PER_LANE = 2;

// A task has no branch, so its tags place it: the first lane with a goal its tags meet, else the fallback lane.
function taskLane(task: SnapshotTask, file: LanesFile): string {
  const tags = new Set(task.tags);
  return file.lanes.find((lane) => lane.goals.some((goal) => goal.tags.some((tag) => tags.has(tag))))?.id ?? file.fallback;
}

const rank = (task: SnapshotTask) => task.priority ?? Number.POSITIVE_INFINITY;

/** `next/<task>`: per lane, the open tasks with the lowest priority rank, ties broken by id. */
export function priorityItems(tasks: readonly SnapshotTask[], file: LanesFile, window: DayWindow): DigestItem[] {
  const open = tasks.filter((task) => task.status !== "done" && task.priority !== undefined && task.priority !== null);
  const sorted = [...open].sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));
  return file.lanes.flatMap((lane) =>
    sorted.filter((task) => taskLane(task, file) === lane.id).slice(0, PRIORITIES_PER_LANE).map((task) => ({
      id: `next/${task.id}`, kind: "task" as const, title: task.title, at: window.since, change: "next", lane: lane.id,
      summary: `${task.id} is priority ${task.priority} in the ${lane.label} lane`,
    })));
}
