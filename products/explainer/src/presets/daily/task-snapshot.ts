import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

/** A task as the snapshot keeps it: only what the day's deltas read, so a snapshot stays small and diffable. */
export const SnapshotTaskSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  status: z.string().min(1),
  tags: z.array(z.string()).default([]),
  created: z.string().optional(),
  done_at: z.string().nullish(),
});
export type SnapshotTask = z.infer<typeof SnapshotTaskSchema>;

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** `task-snapshot/v1`: one initiative's tasks as read on one day; the store keeps one file per day. */
export const TaskSnapshotSchema = z.object({
  schema: z.literal("task-snapshot/v1"),
  initiative: z.string().min(1),
  day: z.string().regex(DAY),
  tasks: z.array(SnapshotTaskSchema),
});
export type TaskSnapshot = z.infer<typeof TaskSnapshotSchema>;

export const TASK_CHANGES = ["opened", "closed", "moved", "owner-gated"] as const;
export type TaskChange = (typeof TASK_CHANGES)[number];

export interface TaskDelta {
  /** `task/<task id>/<change>`: from the task and the change only, so two runs over the same snapshots agree. */
  id: string;
  change: TaskChange;
  task: SnapshotTask;
  /** Board columns before and after; absent for a task the previous snapshot did not hold. */
  from?: string;
  to: string;
}

/** Tags that put an open task in the owner's column; a caller with another vocabulary passes its own. */
export const DEFAULT_OWNER_GATE_TAGS = ["needs-owner", "owner-gates", "owner-ask", "owner-action", "owner-actions", "kind:owner"] as const;

export function takeSnapshot(initiative: string, day: string, tasks: readonly SnapshotTask[]): TaskSnapshot {
  const sorted = [...tasks].sort((a, b) => a.id.localeCompare(b.id));
  return TaskSnapshotSchema.parse({ schema: "task-snapshot/v1", initiative, day, tasks: sorted });
}

/** The kanban column a task sits in: done, the owner's gate, blocked, or its own status. */
export function boardColumn(task: SnapshotTask, ownerGateTags: ReadonlySet<string>): string {
  if (task.status === "done") return "done";
  if (task.tags.some((tag) => ownerGateTags.has(tag))) return "owner-gated";
  if (task.tags.includes("blocked")) return "blocked";
  return task.status;
}

const delta = (task: SnapshotTask, change: TaskChange, to: string, from?: string): TaskDelta =>
  ({ id: `task/${task.id}/${change}`, change, task, to, ...(from === undefined ? {} : { from }) });

function changesOf(task: SnapshotTask, to: string, from: string | undefined): TaskDelta[] {
  if (from === to) return [];
  const arrived = to === "done" ? "closed" : to === "owner-gated" ? "owner-gated" : undefined;
  if (from === undefined) return [delta(task, "opened", to), ...(arrived ? [delta(task, arrived, to)] : [])];
  return [delta(task, arrived ?? "moved", to, from)];
}

// With no earlier snapshot the only evidence of the day is the task's own dates; a move cannot be seen.
function datedChanges(task: SnapshotTask, day: string): TaskDelta[] {
  const opened = task.created?.startsWith(day) ? [delta(task, "opened", task.status)] : [];
  const closed = task.status === "done" && task.done_at?.startsWith(day) ? [delta(task, "closed", "done")] : [];
  return [...opened, ...closed];
}

/** The day's deltas, sorted by id: each task's column change against the previous snapshot. */
export function taskDeltas(today: TaskSnapshot, previous: TaskSnapshot | undefined, ownerGateTags: Iterable<string> = DEFAULT_OWNER_GATE_TAGS): TaskDelta[] {
  const gates = new Set(ownerGateTags);
  const before = new Map(previous?.tasks.map((task) => [task.id, boardColumn(task, gates)]));
  const deltas = today.tasks.flatMap((task) =>
    previous ? changesOf(task, boardColumn(task, gates), before.get(task.id)) : datedChanges(task, today.day));
  return deltas.sort((a, b) => a.id.localeCompare(b.id));
}

const snapshotPath = (dir: string, initiative: string, day: string) => join(dir, initiative, `${day}.json`);

/** The latest stored snapshot strictly before `day`, if any. */
export async function previousSnapshot(dir: string, initiative: string, day: string): Promise<TaskSnapshot | undefined> {
  const names = await readdir(join(dir, initiative)).catch(() => [] as string[]);
  const prior = names.map((name) => name.slice(0, -".json".length)).filter((name) => DAY.test(name) && name < day).sort().at(-1);
  if (prior === undefined) return undefined;
  return TaskSnapshotSchema.parse(JSON.parse(await readFile(snapshotPath(dir, initiative, prior), "utf8")));
}

export async function writeSnapshot(dir: string, snapshot: TaskSnapshot): Promise<string> {
  const file = snapshotPath(dir, snapshot.initiative, snapshot.day);
  await mkdir(join(dir, snapshot.initiative), { recursive: true });
  await writeFile(file, `${JSON.stringify(snapshot, null, 2)}\n`);
  return file;
}

export interface TaskSnapshotOptions {
  initiative: string;
  day: string;
  /** Where snapshots are kept: the explainer's own data dir, never the task store. */
  snapshotDir: string;
  /** Reads the initiative's tasks, read-only. */
  listTasks: (initiative: string) => Promise<SnapshotTask[]>;
  ownerGateTags?: Iterable<string>;
}

export interface TaskSnapshotResult {
  snapshot: TaskSnapshot;
  previousDay?: string;
  deltas: TaskDelta[];
}

/** Reads today's tasks, stores them as the day's snapshot, and diffs them against the latest earlier one. */
export async function readTaskSnapshot(options: TaskSnapshotOptions): Promise<TaskSnapshotResult> {
  const snapshot = takeSnapshot(options.initiative, options.day, await options.listTasks(options.initiative));
  const previous = await previousSnapshot(options.snapshotDir, options.initiative, options.day);
  await writeSnapshot(options.snapshotDir, snapshot);
  const deltas = taskDeltas(snapshot, previous, options.ownerGateTags);
  return { snapshot, deltas, ...(previous ? { previousDay: previous.day } : {}) };
}
