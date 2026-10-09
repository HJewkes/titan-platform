import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT, invokeCommand } from "@titan-design/registry";
import { openSessionGraph } from "@titan-design/session-graph";
import { activeWorkClient } from "./active-work.js";
import type { RepoEvidence } from "./repo-evidence.js";
import { tasksCommands, type TaskDetail, type TasksResult, type TasksSource } from "./tasks.js";
import { startFakeDaemon, type FakeDaemon } from "./test-support.js";

// Synthetic records in active-work's wire shapes; nothing here comes from a real workspace.
const task = (slug: string, id: string, fields: Record<string, unknown> = {}) => ({
  slug, id, title: `Task ${id}`, priority: 1, status: "open", created: "2031-01-05", updated: "2031-03-01", done_at: null, ...fields,
});

const TASKS = [
  task("orbit-relay", "OR-1", { notes: "Handshake retry.", done_when: "A dropped handshake retries with backoff." }),
  task("orbit-relay", "OR-2", { tags: ["dep:OR-5"] }),
  task("orbit-relay", "OR-3"),
  task("orbit-relay", "OR-4", { notes: "Depends on OR-9 (done)." }),
  task("orbit-relay", "OR-5", { tags: ["parent:OR-6"] }),
  task("orbit-relay", "OR-6", { notes: "Epic for the relay." }),
  task("orbit-relay", "OR-7"),
  // A migrated task: edges and deliverables are fields, and its tags are for retrieval only.
  task("orbit-relay", "OR-8", { parent: "OR-6", dep: ["OR-5"], deliverables: ["relay-v1", "relay-ghost"], tags: ["origin:relay"] }),
  task("orbit-relay", "OR-9", { status: "done", done_at: "2031-02-01" }),
  task("garden-plan", "GP-1", { notes: "Order seed trays." }),
];

const ARTIFACTS = {
  items: [{ slug: "orbit-relay", artifacts: { branches: [{ repo: "/synthetic/orbit", name: "pc-or-1-retry" }, { repo: "/synthetic/orbit", name: "pc-or-3-old" }], stashes: [], worktrees: [] } }],
};

const STATUS = {
  slug: "orbit-relay",
  branches: [
    { repo: "/synthetic/orbit", name: "pc-or-1-retry", present: true, last_commit_iso: null, ahead: 2, behind: 0, pr: { number: 41, state: "OPEN", title: "OR-1: Retry", url: "https://example.invalid/41", checks: "pass (3/3)" } },
    { repo: "/synthetic/orbit", name: "pc-or-3-old", present: false, last_commit_iso: null, ahead: null, behind: null, pr: null },
  ],
  worktrees: [{ path: "/synthetic/orbit/.worktrees/or-1", repo: "/synthetic/orbit", branch: "pc-or-1-retry", present: true, dirty: false, files_changed: 0, ahead: 0, behind: 0, has_upstream: true }],
};

const REFERENCES = [
  { slug: "orbit-relay", source: "task", file: "tasks/OR-7.yml", field: "notes", text: "Follows OR-1" },
  { slug: "garden-plan", source: "task", file: "tasks/GP-1.yml", field: "notes", text: "Unlike OR-1" },
];

/** The repository evidence a git and GitHub read would give: OR-1 has an open PR, OR-3 a live branch, OR-7 a stale one. */
const EVIDENCE: RepoEvidence[] = [{
  repo: "example/orbit",
  refs: [
    { repo: "example/orbit", name: "pc-or-3-relay", kind: "worktree", tipAt: 500 },
    { repo: "example/orbit", name: "origin/pc-or-7-done-already", kind: "branch", tipAt: 100 },
  ],
  mergedAt: new Map([["OR-7", 200]]),
  openPrs: [{ repo: "example/orbit", number: 41, headRef: "pc-or-1-retry" }],
}];

const RELAY_V1 = { id: "relay-v1", title: "Relay v1", status: "active", target: "2031-04-01", owner_seat: "relay-seat", tags: [], tasks: { open: 1, done: 0 } };

const EMPTY = { files: 0, bytes: 0, newest_mtime: null };
const CLASSES = { tasks: EMPTY, sessions: EMPTY, notes: EMPTY, sources: EMPTY, nested_sources: EMPTY };

const SESSION = "0a1b2c3d-0000-4000-8000-0000000000aa";
const OTHER = "0a1b2c3d-0000-4000-8000-0000000000bb";

let daemon: FakeDaemon | undefined;
let dir: string;
let calls: string[];
let registryServed: boolean;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "console-tasks-"));
  calls = [];
  registryServed = true;
});

afterEach(async () => {
  await daemon?.close();
  daemon = undefined;
  await rm(dir, { recursive: true, force: true });
});

function answer(command: string, args: Record<string, unknown>): unknown {
  calls.push(command);
  switch (command) {
    case "task.list":
      return { tasks: TASKS.filter((entry) => args.status === "all" || entry.status === "open") };
    case "artifact.list":
      return ARTIFACTS;
    case "artifact.status":
      return STATUS;
    case "context.graph":
      return { id: args.id, kind: "task", subject: null, references: REFERENCES, initiatives_scanned: [], errors: [] };
    case "deliverable.list":
      if (!registryServed) throw new Error("Unknown command deliverable.list");
      return [RELAY_V1];
    case "inventory":
      return { initiatives: [{ slug: "orbit-relay", human_only: false }, { slug: "garden-plan", human_only: true }].map((entry) => ({ ...entry, total: EMPTY, classes: CLASSES })), human_only_known: true };
    default:
      throw new Error(`No answer for ${command}`);
  }
}

function seedGraph(graphPath: string): void {
  const graph = openSessionGraph(graphPath);
  const insert = (sessionId: string, startedAt: string, taskIds: string) => {
    graph.db.prepare("INSERT INTO session (session_id, started_at, ended_at, cwd, ai_title, turn_count) VALUES (?, ?, ?, '/work/example', 'Example', 3)").run(sessionId, startedAt, startedAt);
    graph.db.prepare("INSERT INTO session_origin (session_id, origin_system, agent_name, task_ids, resolved_at) VALUES (?, 'agent-chat', 'impl-a', ?, '2031-03-01T00:00:00Z')").run(sessionId, taskIds);
  };
  try {
    insert(SESSION, "2031-03-01T10:00:00Z", JSON.stringify(["OR-1", "OR-2"]));
    insert(OTHER, "2031-03-01T11:00:00Z", JSON.stringify(["OR-10"]));
    insert("0a1b2c3d-0000-4000-8000-0000000000cc", "2031-03-01T12:00:00Z", "not json");
  } finally {
    graph.db.close();
  }
}

async function source(fields: Partial<TasksSource> = {}): Promise<TasksSource> {
  await daemon?.close();
  daemon = await startFakeDaemon({ ok: true }, answer);
  const graphPath = path.join(dir, "graph.sqlite3");
  if (!existsSync(graphPath)) seedGraph(graphPath);
  return { activeWork: activeWorkClient(daemon.port), sessions: { graphPath }, evidence: async () => EVIDENCE, ...fields };
}

async function invoke<T>(name: "work.tasks" | "work.task", args: Record<string, unknown>, fields: Partial<TasksSource> = {}) {
  const { envelope, exitCode } = await invokeCommand(tasksCommands(await source(fields))[name], args, { warnings: [], format: "json" });
  return { envelope, exitCode, data: (envelope as { data?: T }).data as T };
}

describe("work.tasks", () => {
  it("returns open tasks across initiatives, each staged by the rule that produced it", async () => {
    const { data } = await invoke<TasksResult>("work.tasks", {});

    const byId = Object.fromEntries(data.tasks.map((row) => [row.id, [row.stage, row.stageRule, row.stageGuessed]]));
    expect(byId).toEqual({
      "OR-1": ["review", "open-pr", false],
      "OR-2": ["blocked", "dependency", false],
      "OR-3": ["in-progress", "live-ref", false],
      "OR-4": ["ready", "default", true],
      "OR-5": ["ready", "default", true],
      "OR-6": ["blocked", "open-slices", false],
      "OR-7": ["ready", "merged-commit", false],
      "OR-8": ["blocked", "dependency", false],
      "GP-1": ["ready", "default", true],
    });
    expect(data.tasks.find((row) => row.id === "OR-2")?.stageReason).toBe("Depends on OR-5 (open)");
    expect(data.evidence).toEqual({ repos: ["example/orbit"], degraded: [] });
  });

  it("reads parent and dep the same from edge tags and from fields", async () => {
    const { data } = await invoke<TasksResult>("work.tasks", {});

    const edges = Object.fromEntries(data.tasks.map(({ id, parent, dep, deliverables }) => [id, { parent, dep, deliverables }]));
    expect(edges["OR-2"]).toEqual({ parent: null, dep: ["OR-5"], deliverables: [] });
    expect(edges["OR-5"]).toEqual({ parent: "OR-6", dep: [], deliverables: [] });
    expect(edges["OR-8"]).toEqual({ parent: "OR-6", dep: ["OR-5"], deliverables: ["relay-v1", "relay-ghost"] });
    expect(data.tasks.find((row) => row.id === "OR-8")?.stageReason).toBe("Depends on OR-5 (open)");
    expect(data.tasks.find((row) => row.id === "OR-6")?.stageReason).toBe("2 open slices");
  });

  it("only ever uses the shared stage vocabulary", async () => {
    const { data } = await invoke<TasksResult>("work.tasks", {});
    expect(new Set(data.tasks.map((row) => row.stage))).toEqual(new Set(["review", "blocked", "in-progress", "ready"]));
  });

  it("sends neither notes nor done_when in a list row", async () => {
    const { data } = await invoke<TasksResult>("work.tasks", {});
    expect(data.tasks.find((row) => row.id === "OR-1")).not.toHaveProperty("notes");
    expect(JSON.stringify(data)).not.toContain("Handshake retry.");
  });

  it("never asks active-work for per-branch PR state when listing", async () => {
    await invoke<TasksResult>("work.tasks", {});
    expect(calls).not.toContain("artifact.status");
  });

  it("leaves out a personal initiative's tasks for an export", async () => {
    const { data } = await invoke<TasksResult>("work.tasks", {}, { work: { excludePersonal: true } });
    expect(data.tasks.map((row) => row.slug)).not.toContain("garden-plan");
  });

  it("reports GitHub as degraded instead of failing when open pull requests cannot be read", async () => {
    const evidence = async (): Promise<RepoEvidence[]> => [{ ...EVIDENCE[0]!, openPrs: null, degraded: "Open pull requests in example/orbit unread: offline" }];
    const { data } = await invoke<TasksResult>("work.tasks", {}, { evidence });
    expect(data.tasks.find((row) => row.id === "OR-1")?.stage).toBe("ready");
    expect(data.evidence.degraded).toEqual(["Open pull requests in example/orbit unread: offline"]);
  });
});

describe("work.task", () => {
  it("returns the task with notes, done_when, mentions, artifacts with PR state and its sessions", async () => {
    const { data } = await invoke<TaskDetail>("work.task", { id: "OR-1" });

    expect(data.task).toMatchObject({ id: "OR-1", stage: "review", notes: "Handshake retry.", doneWhen: "A dropped handshake retries with backoff." });
    expect(data.mentions.map((mention) => mention.file)).toEqual(["tasks/OR-7.yml", "tasks/GP-1.yml"]);
    expect(data.artifacts.branches).toEqual([{ repo: "orbit", name: "pc-or-1-retry", present: true, pr: expect.objectContaining({ number: 41, state: "OPEN" }) }]);
    expect(data.artifacts.worktrees).toEqual([{ repo: "orbit", branch: "pc-or-1-retry", present: true }]);
    expect(data.openPrs).toEqual([{ repo: "example/orbit", number: 41, headRef: "pc-or-1-retry" }]);
    expect(data.sessions.map((session) => session.sessionId)).toEqual([SESSION]);
    expect(data.sessionsDegraded).toBeNull();
  });

  it("lists the children a parent tag or a parent field names", async () => {
    const { data } = await invoke<TaskDetail>("work.task", { id: "OR-6" });
    expect(data.children).toEqual([{ id: "OR-5", title: "Task OR-5", status: "open" }, { id: "OR-8", title: "Task OR-8", status: "open" }]);
  });

  it("joins each deliverable id to its registry record, and an unknown id to null", async () => {
    const { data } = await invoke<TaskDetail>("work.task", { id: "OR-8" });
    expect(data.deliverables).toEqual([{ id: "relay-v1", record: RELAY_V1 }, { id: "relay-ghost", record: null }]);
    expect(data.deliverablesDegraded).toBeNull();
  });

  it("asks for no registry when the task names no deliverable", async () => {
    const { data } = await invoke<TaskDetail>("work.task", { id: "OR-2" });
    expect(data).toMatchObject({ deliverables: [], deliverablesDegraded: null, children: [] });
    expect(calls).not.toContain("deliverable.list");
  });

  it("reports the registry as degraded, not failing, when active-work has no deliverable read", async () => {
    registryServed = false;
    const { data } = await invoke<TaskDetail>("work.task", { id: "OR-8" });
    expect(data.deliverables).toEqual([{ id: "relay-v1", record: null }, { id: "relay-ghost", record: null }]);
    expect(data.deliverablesDegraded).toContain("deliverable.list");
  });

  it("sends no absolute file path to the browser", async () => {
    const { data } = await invoke<TaskDetail>("work.task", { id: "OR-1" });
    expect(JSON.stringify(data)).not.toContain("/synthetic/");
  });

  it("returns a done task with the done stage", async () => {
    const { data } = await invoke<TaskDetail>("work.task", { id: "OR-9" });
    expect(data.task).toMatchObject({ stage: "done", stageRule: "status-done", status: "done" });
  });

  it("is not found for an id no initiative holds", async () => {
    const { envelope, exitCode } = await invoke<TaskDetail>("work.task", { id: "OR-404" });
    expect(envelope.ok).toBe(false);
    expect(exitCode).toBe(EXIT.NOINPUT);
    expect(calls).not.toContain("artifact.status");
  });

  it("is not found for a personal initiative's task in an export, and drops personal mentions", async () => {
    expect((await invoke<TaskDetail>("work.task", { id: "GP-1" }, { work: { excludePersonal: true } })).exitCode).toBe(EXIT.NOINPUT);
    const { data } = await invoke<TaskDetail>("work.task", { id: "OR-1" }, { work: { excludePersonal: true } });
    expect(data.mentions.map((mention) => mention.slug)).toEqual(["orbit-relay"]);
  });

  it("returns the task with degraded sessions when the session graph is missing", async () => {
    const { data } = await invoke<TaskDetail>("work.task", { id: "OR-1" }, { sessions: { graphPath: path.join(dir, "absent.sqlite3") } });
    expect(data.sessions).toEqual([]);
    expect(data.sessionsDegraded).toMatchObject({ reason: "graph-missing" });
  });
});
