import { embedSnapshot, pageDataSource } from "@titan-design/react-app";
import type { DataSource } from "@titan-design/rpc-client";
import { EXIT, errorEnvelope, successEnvelope } from "@titan-design/registry";
import { SNAPSHOT_FORMAT, snapshotKey, type Snapshot } from "@titan-design/rpc-client";
import { screen } from "@testing-library/react";
import type { ConsoleCommands } from "../server/commands.js";
import { listPage, tasksArgs } from "../server/task-list.js";
import { renderPage } from "./render-page.test-helpers.js";

type TasksResult = ConsoleCommands["work.tasks"]["result"];
export type TaskDetail = ConsoleCommands["work.task"]["result"];
type TaskMentions = ConsoleCommands["work.taskMentions"]["result"];
type TaskArtifacts = ConsoleCommands["work.taskArtifacts"]["result"];
type Row = TasksResult["tasks"][number];

// Synthetic rows in `work.tasks` shape; nothing here comes from a real workspace.
export const row = (id: string, fields: Partial<Row>): Row => ({
  slug: "orbit-relay", id, title: `Task ${id}`, stage: "ready", stageReason: "No pull request, live branch, worktree, open dependency or hold found", stageGuessed: true, ...fields,
});

const ROWS = [
  row("OR-1", { title: "Retry a dropped handshake", severity: "critical", stage: "review", stageReason: "PR example/orbit#41 is open (head pc-or-1-retry)", stageGuessed: false }),
  row("OR-2", { title: "Report queue depth", severity: "high", stage: "blocked", stageReason: "Depends on OR-5 (open)", stageGuessed: false }),
  row("OR-4", { title: "Document the routing table", severity: "low" }),
  row("LD-3", { slug: "lantern-docs", title: "Merge the battery chapters", severity: "medium", stage: "in-progress", stageReason: "Worktree on branch pc-ld-3 in example/lantern", stageGuessed: false }),
];

export const tasksOf = (rows: readonly Row[]): TasksResult => ({
  fetchedAt: "2031-03-05T00:00:00.000Z",
  evidence: { repos: ["example/orbit"], degraded: [] },
  ...listPage(rows, {}),
});

export const TASKS = tasksOf(ROWS);

export const SESSION = "0a1b2c3d-0000-4000-8000-0000000000aa";

export const DETAIL: TaskDetail = {
  fetchedAt: "2031-03-05T00:00:00.000Z",
  task: {
    ...ROWS[0]!, priority: 1, updated: "2031-03-01", status: "open", stageRule: "open-pr", parent: null, dep: [], deliverables: [],
    notes: "Backoff caps at thirty seconds.", doneWhen: "A dropped handshake retries with backoff.",
  },
  refs: [],
  openPrs: [{ repo: "example/orbit", number: 41, headRef: "pc-or-1-retry" }],
  sessions: [{
    sessionId: SESSION, title: "Handshake retry run", startedAt: "2031-03-01T10:00:00Z", endedAt: null, cwd: null, gitBranch: null, turnCount: 3,
    transcript: null, agentName: "impl-a", parentSessionId: null, taskIds: ["OR-1"], prs: [], usage: [], costUsd: 0,
  }],
  sessionsDegraded: null,
  children: [],
  deliverables: [],
  deliverablesDegraded: null,
  evidence: { repos: ["example/orbit"], degraded: [] },
};

const MENTIONS: TaskMentions = { mentions: [{ slug: "orbit-relay", source: "task", file: "tasks/OR-7.yml", field: "notes", text: "Follows OR-1" }], degraded: null };

const ARTIFACTS: TaskArtifacts = {
  branches: [{ repo: "orbit", name: "pc-or-1-retry", present: true, pr: { number: 41, state: "OPEN", title: "OR-1: Retry", url: "https://example.invalid/41", checks: "pass (3/3)" } }],
  degraded: [],
};

type Roster = ConsoleCommands["agents.roster"]["result"];

export const rosterAgent = (name: string, taskId: string): Roster["agents"][number] => ({
  id: `${name}@1`, idSource: "nameAtRegisteredAt", name, agentId: null, state: "working", stateSource: "presence", origin: "spawned",
  workingOn: null, cwd: null, gitBranch: null, seat: null, surface: null, profile: null, taskId, spawnedBy: null, claudeSessionId: null,
  registeredAt: 1_000, spawnedAt: null, lastEventAt: 9_000, idleMs: 0, dnd: false, provisional: false, tags: [], costUsd: null, costSource: null,
});

export const rosterOf = (agents: Roster["agents"]): Roster => ({ agents, brokerUptimeMs: 1_000, reconnecting: false, history: { events: 1, limit: 1000, oldestAt: 1_000 }, generatedAt: Date.parse("2031-03-05T00:00:00.000Z") });

export function snapshotOf(calls: Snapshot["calls"]): Snapshot {
  return { format: SNAPSHOT_FORMAT, createdAt: "2031-03-05T00:00:00.000Z", calls };
}

export const deferred = (mentions: TaskMentions = MENTIONS, artifacts: TaskArtifacts = ARTIFACTS): Snapshot["calls"] => ({
  [snapshotKey("work.taskMentions", { id: "OR-1" })]: successEnvelope(mentions),
  [snapshotKey("work.taskArtifacts", { id: "OR-1", slug: "orbit-relay" })]: successEnvelope(artifacts),
});

/** Every row behind each recorded snapshot's unfiltered first page, which a filtered or later page is cut from. */
const unfiltered = new WeakMap<Snapshot, { tasks: TasksResult; rows: readonly Row[] }>();

export function recorded(tasks: TasksResult = TASKS, detail: TaskDetail = DETAIL, later: Snapshot["calls"] = deferred(), rows: readonly Row[] = tasks.tasks): Snapshot {
  const snapshot = snapshotOf({
    ...later,
    [snapshotKey("work.tasks", {})]: successEnvelope(tasks),
    [snapshotKey("work.task", { id: "OR-1" })]: successEnvelope(detail),
    [snapshotKey("work.task", { id: "OR-404" })]: errorEnvelope("No task OR-404 in any initiative", EXIT.NOINPUT),
  });
  unfiltered.set(snapshot, { tasks, rows });
  return snapshot;
}

/** Answers a filtered or later `work.tasks` page from the recorded rows, through the server's own filter. */
function snapshotSource(snapshot: Snapshot): DataSource {
  const inner = pageDataSource({ doc: new DOMParser().parseFromString(embedSnapshot("<html><head></head><body></body></html>", snapshot), "text/html") });
  return {
    call: async (name, args, options) => {
      const all = unfiltered.get(snapshot);
      if (name !== "work.tasks" || all === undefined || Object.keys(args ?? {}).length === 0) return inner.call(name, args, options);
      return successEnvelope({ ...all.tasks, ...listPage(all.rows, tasksArgs.parse(args)) });
    },
    subscribe: (handlers, options) => inner.subscribe(handlers, options),
  };
}

/** Holds the deferred task reads until `release`, so a test sees what the page shows while they are still loading. */
export function heldSource(snapshot: Snapshot): { source: DataSource; held: string[]; release: () => void } {
  const inner = snapshotSource(snapshot);
  const held: string[] = [];
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const source: DataSource = {
    call: async (name, args, options) => {
      if (name.startsWith("work.task") && name !== "work.task") {
        held.push(name);
        await gate;
      }
      return inner.call(name, args, options);
    },
    subscribe: (handlers, options) => inner.subscribe(handlers, options),
  };
  return { source, held, release: () => release() };
}

export function renderConsole(hash: string, snapshot: Snapshot | DataSource, { inApp = false } = {}): void {
  renderPage("format" in snapshot ? snapshotSource(snapshot) : snapshot, hash, { inApp });
}

export const group = (stage: string): HTMLElement => screen.getByTestId(`stage-group-${stage}`);
export const shownIds = (): string[] => screen.queryAllByTestId(/^task-row-/).map((element) => element.getAttribute("data-testid")!.slice("task-row-".length));
