import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { readEdges, type Task } from "@titan-design/pm";
import type { SetTask } from "@titan-design/throughput";
import { kindTags, parseTask, type UnparsedTask } from "./throughput-rows.js";

const MILESTONE_TAG = "milestone:";
// Live tags carry stray punctuation from prose edits (`milestone:M4,`).
const TAG_TRAILER = /[.,)]+$/;

type SetSelector = ({ tasks: string[] } | { parent: string } | { milestone: string }) & {
  /** Scopes a milestone whose name recurs across initiatives. */
  initiative?: string;
};

interface SetSelection {
  tasks: SetTask[];
  /** Selected ids found in no allowlisted initiative. */
  notFound: string[];
  /** Selected tasks already done, so excluded from the forecast. */
  skippedDone: string[];
  unparsed: UnparsedTask[];
}

interface Located {
  task: Task;
  initiative: string;
}

interface TaskIndex {
  byId: Map<string, Located>;
  unparsed: UnparsedTask[];
}

/** The open tasks a selector names across the allowlisted initiatives, read from `<root>/<initiative>/tasks/*.yml`. */
export function selectSetTasks(root: string, initiatives: readonly string[], selector: SetSelector): SetSelection {
  const index = loadTaskIndex(root, initiatives);
  const { located, notFound } = resolveSelector(index, selector);
  const selection: SetSelection = { tasks: [], notFound, skippedDone: [], unparsed: index.unparsed };
  for (const { task, initiative } of located) {
    if (task.status === "done") selection.skippedDone.push(task.id);
    else selection.tasks.push(toSetTask(task, initiative));
  }
  return selection;
}

function resolveSelector(index: TaskIndex, selector: SetSelector): { located: Located[]; notFound: string[] } {
  if ("tasks" in selector) return byIds(index, selector.tasks);
  if ("parent" in selector) return byParent(index, selector.parent);
  return { located: byMilestone(index, selector.milestone, selector.initiative), notFound: [] };
}

function loadTaskIndex(root: string, initiatives: readonly string[]): TaskIndex {
  const index: TaskIndex = { byId: new Map(), unparsed: [] };
  for (const initiative of initiatives) {
    const dir = path.join(root, initiative, "tasks");
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).filter((file) => file.endsWith(".yml")).sort()) {
      const task = parseTask(path.join(dir, name));
      if (typeof task === "string") index.unparsed.push({ file: path.join(initiative, "tasks", name), reason: task });
      else addTask(index, task, initiative);
    }
  }
  return index;
}

function addTask(index: TaskIndex, task: Task, initiative: string): void {
  const prior = index.byId.get(task.id);
  if (prior) throw new Error(`task ${task.id} appears in both ${prior.initiative} and ${initiative}`);
  index.byId.set(task.id, { task, initiative });
}

function byIds(index: TaskIndex, ids: readonly string[]): { located: Located[]; notFound: string[] } {
  const located: Located[] = [];
  const notFound: string[] = [];
  for (const id of new Set(ids)) {
    const hit = index.byId.get(id);
    if (hit) located.push(hit);
    else notFound.push(id);
  }
  return { located, notFound };
}

/** Every transitive descendant by parent edge; the parent itself is never in the set. */
function byParent(index: TaskIndex, parent: string): { located: Located[]; notFound: string[] } {
  const children = childrenByParent(index);
  const seen = new Set([parent]);
  const located: Located[] = [];
  const visit = (id: string): void => {
    const next = (children.get(id) ?? []).filter((hit) => !seen.has(hit.task.id));
    for (const hit of next) seen.add(hit.task.id);
    located.push(...next);
  };
  visit(parent);
  // `located` grows while it is walked, which makes this the breadth-first queue.
  for (const hit of located) visit(hit.task.id);
  return { located, notFound: index.byId.has(parent) ? [] : [parent] };
}

function childrenByParent(index: TaskIndex): Map<string, Located[]> {
  const children = new Map<string, Located[]>();
  for (const hit of index.byId.values()) {
    const { parent } = readEdges(hit.task);
    if (parent !== null) children.set(parent, [...(children.get(parent) ?? []), hit]);
  }
  return children;
}

function byMilestone(index: TaskIndex, milestone: string, initiative: string | undefined): Located[] {
  const tagged = [...index.byId.values()].filter((hit) => milestones(hit.task).includes(milestone));
  const homes = [...new Set(tagged.map((hit) => hit.initiative))];
  if (initiative === undefined && homes.length > 1) {
    throw new Error(`milestone ${milestone} recurs in ${homes.join(", ")}; pass --initiative`);
  }
  return initiative === undefined ? tagged : tagged.filter((hit) => hit.initiative === initiative);
}

function milestones(task: Task): string[] {
  return (task.tags ?? []).filter((tag) => tag.startsWith(MILESTONE_TAG)).map((tag) => tag.slice(MILESTONE_TAG.length).replace(TAG_TRAILER, ""));
}

function toSetTask(task: Task, initiative: string): SetTask {
  return { taskId: task.id, kind: kindTags(task)[0] ?? task.kind ?? null, estimate: task.estimate ?? null, initiative };
}
