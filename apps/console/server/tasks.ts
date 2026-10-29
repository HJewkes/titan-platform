import { z } from "zod";
import { readEdges, taskTree, type Task } from "@titan-design/pm";
import { EXIT } from "@titan-design/registry";
import { branchStateReader, type BranchStateReader, type BranchStates } from "./branch-prs.js";
import { failure, type ActiveWork, type ReadResult, type WireDeliverable, type WireTask } from "./active-work.js";
import { readCommand } from "./owner-guard.js";
import { gitEvidenceReader, indexByTaskId, type EvidenceReader, type RepoEvidence } from "./repo-evidence.js";
import { sessionsForTask, type SessionsSource, type TaskSessions } from "./sessions.js";
import { listPage, listRow, tasksArgs, type TaskListPage, type TasksArgs } from "./task-list.js";
import { deriveStage, taskIdsIn, type PrEvidence, type RefEvidence, type StageEvidence, type StageRule, type TaskStage } from "./task-stage.js";
import { isPersonal, slugsForPrefix, taskRowOf, type WorkOptions } from "./work.js";

export interface TasksSource {
  activeWork: ActiveWork;
  sessions: SessionsSource;
  /** Defaults to one cached git and GitHub read per repository named in any `artifacts.yml`. */
  evidence?: EvidenceReader;
  /** Defaults to one cached `gh pr list` per GitHub repository a task's branches live in. */
  branches?: BranchStateReader;
  work?: WorkOptions;
}

type TaskRow = ReturnType<typeof taskRowOf> & {
  status: "open" | "done";
  stage: TaskStage;
  stageRule: StageRule;
  stageReason: string;
  /** True for the default rule: nothing was found either way, so the stage is not a verified state. */
  stageGuessed: boolean;
  /** Edges from pm's `readEdges`: the field when the task has one, else the edge tags, so both shapes read the same. */
  parent: string | null;
  dep: string[];
  deliverables: string[];
};

interface EvidenceSummary {
  /** `owner/name` or directory name of each repository read. */
  repos: string[];
  /** Why a stage could be missing evidence, such as GitHub being unreachable. */
  degraded: string[];
}

/** Rows come in active-work's priority order, and `initiatives` holds each initiative with an open task. */
export interface TasksResult extends TaskListPage {
  fetchedAt: string;
  evidence: EvidenceSummary;
}

type WireReference = ReadResult<"context.graph">["references"][number];

export interface TaskDetail {
  fetchedAt: string;
  task: TaskRow & { notes?: string; doneWhen?: string };
  /** Live refs and open pull requests carrying the id, the evidence the stage was derived from. */
  refs: RefEvidence[];
  openPrs: PrEvidence[];
  sessions: TaskSessions["sessions"];
  sessionsDegraded: TaskSessions["degraded"];
  evidence: EvidenceSummary;
  /** Open tasks whose parent edge names this one, in active-work's priority order; done children are not read. */
  children: { id: string; title: string; status: string }[];
  /** Each id in the task's `deliverables`, with its `deliverable.list` row, or null when no record has that id. */
  deliverables: { id: string; record: WireDeliverable | null }[];
  /** Why the registry could not be read, such as a daemon older than active-work 0.23; every record is null then. */
  deliverablesDegraded: string | null;
}

/** Mentions are slow to find (`context.graph` scans every initiative), so the page asks for them after the shell. */
export interface TaskMentions {
  /** Exact-id references from other tasks, session records and artifacts, as active-work's `context.graph` finds them. */
  mentions: WireReference[];
  /** Why mentions could not be read, such as `context.graph` passing the read timeout; mentions is empty then. */
  degraded: string | null;
}

/** The task's initiative's `artifacts.yml` branches carrying the id, with live PR state; the page asks after the shell. */
export type TaskArtifacts = BranchStates;

const SESSION_LIMIT = 50;
const TASK_ID = /^[A-Z][A-Z0-9]*-\d+$/;

export function tasksCommands(source: TasksSource) {
  const evidence = source.evidence ?? gitEvidenceReader();
  return {
    "work.tasks": readCommand({
      name: "work.tasks",
      description: "Open tasks across every initiative, each with a derived stage, the rule that produced it and its evidence",
      args: tasksArgs,
      result: z.custom<TasksResult>(),
      run: (args) => readTasks(source, evidence, args),
    }),
    "work.task": readCommand({
      name: "work.task",
      description: "One task with its derived stage, children and the sessions spawned for it; mentions and branch PR state are separate reads",
      args: z.object({ id: z.string().regex(TASK_ID) }),
      result: z.custom<TaskDetail>(),
      run: ({ id }) => readTask(source, evidence, id),
    }),
    ...deferredTaskCommands(source, source.branches ?? branchStateReader()),
  };
}

/** The task page's slow sections, read after its shell renders so neither holds the shell up. */
function deferredTaskCommands(source: TasksSource, branches: BranchStateReader) {
  return {
    "work.taskMentions": readCommand({
      name: "work.taskMentions",
      description: "Records in any initiative that mention one task id, as active-work's context.graph finds them",
      args: z.object({ id: z.string().regex(TASK_ID) }),
      result: z.custom<TaskMentions>(),
      run: ({ id }) => readMentions(source, id),
    }),
    "work.taskArtifacts": readCommand({
      name: "work.taskArtifacts",
      description: "The branches in a task's initiative artifacts that carry its id, each with its pull request state",
      args: z.object({ id: z.string().regex(TASK_ID), slug: z.string().min(1) }),
      result: z.custom<TaskArtifacts>(),
      run: ({ id, slug }) => readArtifacts(source, branches, id, slug),
    }),
  };
}

/** Repositories named by any initiative's artifacts; worktree paths resolve to the same clone. */
async function readEvidence(activeWork: ActiveWork, reader: EvidenceReader): Promise<RepoEvidence[]> {
  const { items } = await activeWork.read("artifact.list", { all_initiatives: true });
  return reader(items.flatMap(({ artifacts }) => [...artifacts.branches.map((branch) => branch.repo), ...artifacts.worktrees.map((tree) => tree.repo)]));
}

async function personalSlugs(activeWork: ActiveWork, options: WorkOptions = {}): Promise<Set<string>> {
  if (!options.excludePersonal) return new Set();
  const inventory = await activeWork.read("inventory");
  const personal = inventory.initiatives.filter((entry) => isPersonal(inventory.human_only_known, entry)).map((entry) => entry.slug);
  // An unread charter makes every slug personal, including ones the inventory does not list.
  return inventory.human_only_known ? new Set(personal) : new Set(["*"]);
}

const keeps = (personal: Set<string>) => (slug: string): boolean => !personal.has("*") && !personal.has(slug);

async function readTasks(source: TasksSource, reader: EvidenceReader, args: TasksArgs): Promise<TasksResult> {
  const [list, repos, personal] = await Promise.all([
    source.activeWork.read("task.list", { all_initiatives: true }),
    readEvidence(source.activeWork, reader),
    personalSlugs(source.activeWork, source.work),
  ]);
  const evidence = stageEvidence(list.tasks, repos);
  const rows = list.tasks.filter((task) => keeps(personal)(task.slug)).map((task) => listRow(stagedRow(task, evidence)));
  return { fetchedAt: new Date().toISOString(), ...listPage(rows, args), evidence: summary(repos) };
}

// readEdges and taskTree read only id, title, status, estimate, tags, parent and dep, which a wire task carries.
const asPmTask = (task: WireTask): Task => task as unknown as Task;

function stagedRow(task: WireTask, evidence: StageEvidence): TaskRow {
  const { parent, dep } = readEdges(asPmTask(task));
  const { stage, rule, reason, guessed } = deriveStage({ ...task, dep }, evidence);
  const edges = { parent, dep, deliverables: task.deliverables ?? [] };
  return { ...taskRowOf(task), status: task.status, stage, stageRule: rule, stageReason: reason, stageGuessed: guessed, ...edges };
}

function summary(repos: readonly RepoEvidence[], more: readonly string[] = []): EvidenceSummary {
  return { repos: repos.map((entry) => entry.repo), degraded: [...repos.flatMap((entry) => (entry.degraded ? [entry.degraded] : [])), ...more] };
}

function stageEvidence(tasks: readonly WireTask[], repos: readonly RepoEvidence[]): StageEvidence {
  const open = tasks.filter((task) => task.status === "open");
  const openChildren = new Map<string, number>();
  for (const task of open) {
    const { parent } = readEdges(asPmTask(task));
    if (parent !== null) openChildren.set(parent, (openChildren.get(parent) ?? 0) + 1);
  }
  const mergedAt = new Map<string, number>();
  for (const [id, at] of repos.flatMap((entry) => [...entry.mergedAt])) mergedAt.set(id, Math.max(at, mergedAt.get(id) ?? at));
  return {
    openIds: new Set(open.map((task) => task.id)),
    openChildren,
    openPrs: indexByTaskId(repos.flatMap((entry) => entry.openPrs ?? [])),
    refs: indexByTaskId(repos.flatMap((entry) => entry.refs)),
    mergedAt,
  };
}

async function readTask(source: TasksSource, reader: EvidenceReader, id: string): Promise<TaskDetail> {
  const { activeWork } = source;
  const { open, personal, task } = await lookUpTask(source, id);
  const [repos, sessions, joined] = await Promise.all([
    readEvidence(activeWork, reader),
    sessionsForTask(source.sessions, id, SESSION_LIMIT),
    joinDeliverables(activeWork, task.deliverables ?? []),
  ]);
  const evidence = stageEvidence(open, repos);
  const kept = keeps(personal);
  return {
    fetchedAt: new Date().toISOString(),
    task: detailRow(task, evidence),
    refs: [...(evidence.refs.get(id) ?? [])],
    openPrs: [...(evidence.openPrs.get(id) ?? [])],
    sessions: sessions.sessions,
    sessionsDegraded: sessions.degraded,
    evidence: summary(repos),
    children: childrenOf(open.filter((entry) => kept(entry.slug)), id),
    ...joined,
  };
}

/** The open list is what the stage needs anyway, and holds the task unless it is done. It is read before the other
 *  legs because active-work answers on one event loop, and context.graph beside it pushes it past the read timeout. */
async function lookUpTask(source: TasksSource, id: string): Promise<{ open: WireTask[]; personal: Set<string>; task: WireTask }> {
  const { activeWork } = source;
  const [open, personal] = await Promise.all([activeWork.read("task.list", { all_initiatives: true }), personalSlugs(activeWork, source.work)]);
  const task = open.tasks.find((entry) => entry.id === id) ?? (await findDoneTask(activeWork, id));
  if (!task || !keeps(personal)(task.slug)) throw failure(`No task ${id} in any initiative`, EXIT.NOINPUT);
  return { open: open.tasks, personal, task };
}

function detailRow(task: WireTask, evidence: StageEvidence): TaskDetail["task"] {
  return { ...stagedRow(task, evidence), ...(task.notes !== undefined ? { notes: task.notes } : {}), ...(task.done_when !== undefined ? { doneWhen: task.done_when } : {}) };
}

/** A done task is not in the open list: its id prefix names the initiative, and `task.show` reads that one file. */
async function findDoneTask(activeWork: ActiveWork, id: string): Promise<WireTask | undefined> {
  for (const slug of await slugsForPrefix(activeWork, id.slice(0, id.lastIndexOf("-")))) {
    const found = await showTask(activeWork, slug, id);
    if (found) return found;
  }
  return undefined;
}

async function showTask(activeWork: ActiveWork, slug: string, id: string): Promise<WireTask | undefined> {
  try {
    return { ...(await activeWork.read("task.show", { slug, id })), slug };
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    if (code === EXIT.NOINPUT) return undefined;
    // A daemon without task.show still answers one initiative's list, far short of every initiative's done tasks.
    if (code === EXIT.USAGE) return (await activeWork.read("task.list", { slug, status: "all" })).tasks.find((entry) => entry.id === id);
    throw error;
  }
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

async function readMentions(source: TasksSource, id: string): Promise<TaskMentions> {
  try {
    const [{ references }, personal] = await Promise.all([source.activeWork.read("context.graph", { id }), personalSlugs(source.activeWork, source.work)]);
    return { mentions: references.filter((reference) => keeps(personal)(reference.slug)), degraded: null };
  } catch (error) {
    return { mentions: [], degraded: `Mentions unread: ${messageOf(error)}` };
  }
}

/** Only the task's own branches are looked up, so a page never pays for every branch its initiative ever registered. */
async function readArtifacts(source: TasksSource, reader: BranchStateReader, id: string, slug: string): Promise<TaskArtifacts> {
  const personal = await personalSlugs(source.activeWork, source.work);
  if (!keeps(personal)(slug)) throw failure(`No initiative ${slug}`, EXIT.NOINPUT);
  try {
    const { items } = await source.activeWork.read("artifact.list", { slug });
    const branches = items.flatMap((item) => item.artifacts.branches).filter((branch) => carries(id, branch.name, branch.note));
    return branches.length === 0 ? { branches: [], degraded: [] } : await reader(branches);
  } catch (error) {
    return { branches: [], degraded: [`Artifacts unread: ${messageOf(error)}`] };
  }
}

function childrenOf(tasks: readonly WireTask[], id: string): TaskDetail["children"] {
  const tree = taskTree(tasks.map(asPmTask), id);
  return (tree?.children ?? []).map(({ id: child, title, status }) => ({ id: child, title, status }));
}

type DeliverableJoin = Pick<TaskDetail, "deliverables" | "deliverablesDegraded">;

/** Reads the registry only for a task that names a deliverable, so an older daemon is asked nothing it cannot answer. */
async function joinDeliverables(activeWork: ActiveWork, ids: readonly string[]): Promise<DeliverableJoin> {
  if (ids.length === 0) return { deliverables: [], deliverablesDegraded: null };
  try {
    const registry = new Map((await activeWork.read("deliverable.list")).map((record) => [record.id, record]));
    return { deliverables: ids.map((id) => ({ id, record: registry.get(id) ?? null })), deliverablesDegraded: null };
  } catch (error) {
    return { deliverables: ids.map((id) => ({ id, record: null })), deliverablesDegraded: `Deliverables unread: ${(error as Error).message}` };
  }
}

const carries = (id: string, ...texts: (string | null | undefined)[]): boolean => texts.some((text) => text != null && taskIdsIn(text).includes(id));
