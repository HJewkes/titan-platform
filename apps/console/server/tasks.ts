import path from "node:path";
import { z } from "zod";
import { readEdges, taskTree, type Deliverable, type Task } from "@titan-design/pm";
import { EXIT } from "@titan-design/registry";
import { failure, type ActiveWork, type ReadResult, type WireTask } from "./active-work.js";
import { readCommand } from "./owner-guard.js";
import { gitEvidenceReader, indexByTaskId, type EvidenceReader, type RepoEvidence } from "./repo-evidence.js";
import { sessionsForTask, type SessionsSource, type TaskSessions } from "./sessions.js";
import { deriveStage, taskIdsIn, type PrEvidence, type RefEvidence, type StageEvidence, type StageRule, type TaskStage } from "./task-stage.js";
import { isPersonal, taskRowOf, type WorkOptions } from "./work.js";

export interface TasksSource {
  activeWork: ActiveWork;
  sessions: SessionsSource;
  /** Defaults to one cached git and GitHub read per repository named in any `artifacts.yml`. */
  evidence?: EvidenceReader;
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

export interface TasksResult {
  fetchedAt: string;
  tasks: TaskRow[];
  evidence: EvidenceSummary;
}

type WireReference = ReadResult<"context.graph">["references"][number];
type WireStatus = ReadResult<"artifact.status">;

export interface TaskDetail {
  fetchedAt: string;
  task: TaskRow & { notes?: string; doneWhen?: string };
  /** Exact-id references from other tasks, session records and artifacts, as active-work's `context.graph` finds them. */
  mentions: WireReference[];
  /** `artifacts.yml` rows carrying the id, with live PR state from active-work's `artifact.status`. */
  artifacts: {
    branches: { repo: string; name: string; note?: string; present: boolean; pr: WireStatus["branches"][number]["pr"] }[];
    worktrees: { repo: string; branch: string | null; holding?: string; present: boolean; pr?: number }[];
  };
  /** Live refs and open pull requests carrying the id, the evidence the stage was derived from. */
  refs: RefEvidence[];
  openPrs: PrEvidence[];
  sessions: TaskSessions["sessions"];
  sessionsDegraded: TaskSessions["degraded"];
  evidence: EvidenceSummary;
  /** Tasks whose parent edge names this one, in active-work's priority order. */
  children: { id: string; title: string; status: string }[];
  /** Each id in the task's `deliverables`, with its registry record, or null when no record has that id. */
  deliverables: { id: string; record: Deliverable | null }[];
  /** Why the registry could not be read, such as a daemon older than active-work 0.23; every record is null then. */
  deliverablesDegraded: string | null;
}

const SESSION_LIMIT = 50;

export function tasksCommands(source: TasksSource) {
  const evidence = source.evidence ?? gitEvidenceReader();
  return {
    "work.tasks": readCommand({
      name: "work.tasks",
      description: "Open tasks across every initiative, each with a derived stage, the rule that produced it and its evidence",
      args: z.object({}),
      result: z.custom<TasksResult>(),
      run: () => readTasks(source, evidence),
    }),
    "work.task": readCommand({
      name: "work.task",
      description: "One task with its derived stage, mentions, artifacts with PR state, and the sessions spawned for it",
      args: z.object({ id: z.string().regex(/^[A-Z][A-Z0-9]*-\d+$/) }),
      result: z.custom<TaskDetail>(),
      run: ({ id }) => readTask(source, evidence, id),
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

async function readTasks(source: TasksSource, reader: EvidenceReader): Promise<TasksResult> {
  const [list, repos, personal] = await Promise.all([
    source.activeWork.read("task.list", { all_initiatives: true }),
    readEvidence(source.activeWork, reader),
    personalSlugs(source.activeWork, source.work),
  ]);
  const evidence = stageEvidence(list.tasks, repos);
  return { fetchedAt: new Date().toISOString(), tasks: list.tasks.filter((task) => keeps(personal)(task.slug)).map((task) => stagedRow(task, evidence)), evidence: summary(repos) };
}

// readEdges and taskTree read only id, title, status, estimate, tags, parent and dep, which a wire task carries.
const asPmTask = (task: WireTask): Task => task as unknown as Task;

function stagedRow(task: WireTask, evidence: StageEvidence): TaskRow {
  const { parent, dep } = readEdges(asPmTask(task));
  const { stage, rule, reason, guessed } = deriveStage({ ...task, dep }, evidence);
  const edges = { parent, dep, deliverables: task.deliverables ?? [] };
  return { ...taskRowOf(task), status: task.status, stage, stageRule: rule, stageReason: reason, stageGuessed: guessed, ...edges };
}

function summary(repos: readonly RepoEvidence[]): EvidenceSummary {
  return { repos: repos.map((entry) => entry.repo), degraded: repos.flatMap((entry) => (entry.degraded ? [entry.degraded] : [])) };
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
  const [list, personal] = await Promise.all([activeWork.read("task.list", { all_initiatives: true, status: "all" }), personalSlugs(activeWork, source.work)]);
  const task = list.tasks.find((entry) => entry.id === id);
  if (!task || !keeps(personal)(task.slug)) throw failure(`No task ${id} in any initiative`, EXIT.NOINPUT);
  const [repos, mentions, status, sessions, joined] = await Promise.all([
    readEvidence(activeWork, reader),
    activeWork.read("context.graph", { id }),
    activeWork.read("artifact.status", { slug: task.slug }),
    sessionsForTask(source.sessions, id, SESSION_LIMIT),
    joinDeliverables(activeWork, task.deliverables ?? []),
  ]);
  const evidence = stageEvidence(list.tasks, repos);
  return {
    fetchedAt: new Date().toISOString(),
    task: { ...stagedRow(task, evidence), ...(task.notes !== undefined ? { notes: task.notes } : {}), ...(task.done_when !== undefined ? { doneWhen: task.done_when } : {}) },
    mentions: mentions.references.filter((reference) => keeps(personal)(reference.slug)),
    artifacts: artifactsOf(status, id),
    refs: [...(evidence.refs.get(id) ?? [])],
    openPrs: [...(evidence.openPrs.get(id) ?? [])],
    sessions: sessions.sessions,
    sessionsDegraded: sessions.degraded,
    evidence: summary(repos),
    children: childrenOf(list.tasks.filter((entry) => keeps(personal)(entry.slug)), id),
    ...joined,
  };
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
    const registry = new Map((await activeWork.read("deliverable.list")).deliverables.map((record) => [record.id, record]));
    return { deliverables: ids.map((id) => ({ id, record: registry.get(id) ?? null })), deliverablesDegraded: null };
  } catch (error) {
    return { deliverables: ids.map((id) => ({ id, record: null })), deliverablesDegraded: `Deliverables unread: ${(error as Error).message}` };
  }
}

const carries = (id: string, ...texts: (string | null | undefined)[]): boolean => texts.some((text) => text != null && taskIdsIn(text).includes(id));

/** Repos are absolute paths in `artifacts.yml`; the page gets the directory name, and no worktree path. */
function artifactsOf(status: WireStatus, id: string): TaskDetail["artifacts"] {
  const branches = status.branches.filter((branch) => carries(id, branch.name, branch.note));
  const worktrees = status.worktrees.filter((tree) => carries(id, tree.branch, tree.holding, tree.note));
  return {
    branches: branches.map(({ repo, name, note, present, pr }) => ({ repo: path.basename(repo), name, ...(note ? { note } : {}), present, pr })),
    worktrees: worktrees.map(({ repo, branch, holding, present, pr }) => ({ repo: path.basename(repo), branch, ...(holding ? { holding } : {}), present, ...(pr !== undefined ? { pr } : {}) })),
  };
}
