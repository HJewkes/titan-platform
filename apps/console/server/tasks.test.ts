import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT, invokeCommand } from "@titan-design/registry";
import { openSessionGraph } from "@titan-design/session-graph";
import { activeWorkClient } from "./active-work.js";
import type { BranchInput, BranchStates } from "./branch-prs.js";
import type { RepoEvidence } from "./repo-evidence.js";
import { tasksCommands, type TaskArtifacts, type TaskDetail, type TaskMentions, type TasksResult, type TasksSource } from "./tasks.js";
import { startFakeDaemon, type FakeDaemon } from "./test-support.js";

// Synthetic records in active-work's wire shapes; nothing here comes from a real workspace.
const task = (slug: string, id: string, fields: Record<string, unknown> = {}) => ({
  slug, id, title: `Task ${id}`, priority: 1, status: "open", created: "2031-01-05", updated: "2031-03-01", done_at: null, ...fields,
});

const TASKS = [
  task("orbit-relay", "OR-1", { severity: "high", notes: "Handshake retry.", done_when: "A dropped handshake retries with backoff." }),
  task("orbit-relay", "OR-2", { tags: ["dep:OR-5"] }),
  task("orbit-relay", "OR-3"),
  task("orbit-relay", "OR-4", { notes: "Depends on OR-9 (done)." }),
  task("orbit-relay", "OR-5", { tags: ["parent:OR-6"] }),
  task("orbit-relay", "OR-6", { severity: "high", notes: "Epic for the relay." }),
  task("orbit-relay", "OR-7"),
  // A migrated task: edges and deliverables are fields, and its tags are for retrieval only.
  task("orbit-relay", "OR-8", { parent: "OR-6", dep: ["OR-5"], deliverables: ["relay-v1", "relay-ghost"], tags: ["origin:relay"] }),
  task("orbit-relay", "OR-9", { status: "done", done_at: "2031-02-01" }),
  task("garden-plan", "GP-1", { notes: "Order seed trays." }),
];

const ARTIFACTS = {
  items: [{ slug: "orbit-relay", artifacts: { branches: [{ repo: "/synthetic/orbit", name: "pc-or-1-retry" }, { repo: "/synthetic/orbit", name: "pc-or-3-old" }], stashes: [], worktrees: [] } }],
};

const PR_41 = { number: 41, state: "OPEN", title: "OR-1: Retry", url: "https://example.invalid/41", checks: "pass (3/3)" };

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
let taskLists: Record<string, unknown>[];
let registryServed: boolean;
let taskShowServed: boolean;
let failing: Set<string>;
let branchLookups: BranchInput[][];

/** What the cached `gh pr list` reader answers, without spawning anything. */
async function fakeBranches(branches: readonly BranchInput[]): Promise<BranchStates> {
  branchLookups.push([...branches]);
  return { branches: branches.map(({ name }) => ({ repo: "orbit", name, present: true, pr: name === "pc-or-1-retry" ? PR_41 : null })), degraded: [] };
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "console-tasks-"));
  calls = [];
  taskLists = [];
  registryServed = true;
  taskShowServed = true;
  failing = new Set();
  branchLookups = [];
});

afterEach(async () => {
  await daemon?.close();
  daemon = undefined;
  await rm(dir, { recursive: true, force: true });
});

const PREFIXES: Record<string, string> = { "orbit-relay": "OR", "garden-plan": "GP" };

const notFound = (message: string) => Object.assign(new Error(message), { code: EXIT.NOINPUT });

function showTask(args: Record<string, unknown>): unknown {
  if (!taskShowServed) throw new Error("Unknown command: task.show");
  const found = TASKS.find((entry) => entry.slug === args.slug && entry.id === args.id);
  if (!found) throw notFound(`task ${String(args.id)} not found in ${String(args.slug)}`);
  return Object.fromEntries(Object.entries(found).filter(([key]) => key !== "slug"));
}

function answer(command: string, args: Record<string, unknown>): unknown {
  calls.push(command);
  if (failing.has(command)) throw new Error("The operation was aborted due to timeout");
  switch (command) {
    case "task.list":
      taskLists.push(args);
      return { tasks: TASKS.filter((entry) => (args.slug === undefined || entry.slug === args.slug) && (args.status === "all" || entry.status === "open")) };
    case "task.show":
      return showTask(args);
    case "list":
      return { sections: [{ heading: "Focused", items: Object.keys(PREFIXES).map((slug) => ({ slug, title: slug, state: "focused", updated: "2031-03-01" })) }], parse_errors: [] };
    case "source.read":
      return { content: `---\ntask_prefix: ${PREFIXES[String(args.slug)]}\n---\nBrief.`, truncated: false };
    case "artifact.list":
      return args.slug === undefined || args.slug === "orbit-relay" ? ARTIFACTS : { items: [] };
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
  return { activeWork: activeWorkClient(daemon.port), sessions: { graphPath }, evidence: async () => EVIDENCE, branches: fakeBranches, ...fields };
}

async function invoke<T>(name: "work.tasks" | "work.task" | "work.taskMentions" | "work.taskArtifacts", args: Record<string, unknown>, fields: Partial<TasksSource> = {}) {
  const { envelope, exitCode } = await invokeCommand(tasksCommands(await source(fields))[name], args, { warnings: [], format: "json" });
  return { envelope, exitCode, data: (envelope as { data?: T }).data as T };
}

describe("work.tasks", () => {
  it("returns open tasks across initiatives, each with its derived stage", async () => {
    const { data } = await invoke<TasksResult>("work.tasks", {});

    const byId = Object.fromEntries(data.tasks.map((row) => [row.id, [row.stage, row.stageGuessed]]));
    expect(byId).toEqual({
      "OR-1": ["review", false],
      "OR-2": ["blocked", false],
      "OR-3": ["in-progress", false],
      "OR-4": ["ready", true],
      "OR-5": ["ready", true],
      "OR-6": ["blocked", false],
      "OR-7": ["ready", false],
      "OR-8": ["blocked", false],
      "GP-1": ["ready", true],
    });
    expect(data.tasks.find((row) => row.id === "OR-2")?.stageReason).toBe("Depends on OR-5 (open)");
    expect(data.tasks.find((row) => row.id === "OR-6")?.stageReason).toBe("2 open slices");
    expect(data.evidence).toEqual({ repos: ["example/orbit"], degraded: [] });
  });

  it("sends a row only the fields the board renders", async () => {
    const { data } = await invoke<TasksResult>("work.tasks", {});
    const keys = new Set(data.tasks.flatMap((row) => Object.keys(row)));
    expect(keys).toEqual(new Set(["slug", "id", "title", "severity", "stage", "stageReason", "stageGuessed"]));
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
  it("reads parent and dep the same from edge tags and from fields", async () => {
    const edgesOf = async (id: string) => {
      const { task } = (await invoke<TaskDetail>("work.task", { id })).data;
      return { parent: task.parent, dep: task.dep, deliverables: task.deliverables };
    };
    expect(await edgesOf("OR-2")).toEqual({ parent: null, dep: ["OR-5"], deliverables: [] });
    expect(await edgesOf("OR-5")).toEqual({ parent: "OR-6", dep: [], deliverables: [] });
    expect(await edgesOf("OR-8")).toEqual({ parent: "OR-6", dep: ["OR-5"], deliverables: ["relay-v1", "relay-ghost"] });
  });

  it("returns the task with notes, done_when, open PRs and its sessions", async () => {
    const { data } = await invoke<TaskDetail>("work.task", { id: "OR-1" });

    expect(data.task).toMatchObject({ id: "OR-1", stage: "review", notes: "Handshake retry.", doneWhen: "A dropped handshake retries with backoff." });
    expect(data.openPrs).toEqual([{ repo: "example/orbit", number: 41, headRef: "pc-or-1-retry" }]);
    expect(data.sessions.map((session) => session.sessionId)).toEqual([SESSION]);
    expect(data.sessionsDegraded).toBeNull();
  });

  it("returns the shell without reading mentions or any branch's PR state", async () => {
    const { data } = await invoke<TaskDetail>("work.task", { id: "OR-1" });

    expect(data.task.id).toBe("OR-1");
    expect(calls).not.toContain("context.graph");
    expect(calls).not.toContain("artifact.status");
    expect(branchLookups).toEqual([]);
    expect(data).not.toHaveProperty("mentions");
    expect(data).not.toHaveProperty("artifacts");
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

  it("returns a done task with the done stage, read from its own initiative by id", async () => {
    const { data } = await invoke<TaskDetail>("work.task", { id: "OR-9" });
    expect(data.task).toMatchObject({ id: "OR-9", slug: "orbit-relay", stage: "done", stageRule: "status-done", status: "done" });
    expect(calls).toContain("task.show");
  });

  it("never asks for every initiative's done tasks to find one id", async () => {
    await invoke<TaskDetail>("work.task", { id: "OR-9" });
    expect(taskLists).toEqual([{ all_initiatives: true }]);
  });

  it("finds a done task through one initiative's list on a daemon without task.show", async () => {
    taskShowServed = false;
    const { data } = await invoke<TaskDetail>("work.task", { id: "OR-9" });
    expect(data.task).toMatchObject({ id: "OR-9", status: "done" });
    expect(taskLists).toContainEqual({ slug: "orbit-relay", status: "all" });
    expect(taskLists).not.toContainEqual(expect.objectContaining({ all_initiatives: true, status: "all" }));
  });

  it("is not found, not failing, for an id whose prefix no initiative claims", async () => {
    const { exitCode } = await invoke<TaskDetail>("work.task", { id: "ZZ-1" });
    expect(exitCode).toBe(EXIT.NOINPUT);
    expect(calls).not.toContain("task.show");
  });

  it("is not found for an id no initiative holds", async () => {
    const { envelope, exitCode } = await invoke<TaskDetail>("work.task", { id: "OR-404" });
    expect(envelope.ok).toBe(false);
    expect(exitCode).toBe(EXIT.NOINPUT);
    expect(calls).toContain("task.show");
  });

  it("is not found for a personal initiative's task in an export", async () => {
    expect((await invoke<TaskDetail>("work.task", { id: "GP-1" }, { work: { excludePersonal: true } })).exitCode).toBe(EXIT.NOINPUT);
  });

  it("returns the task with degraded sessions when the session graph is missing", async () => {
    const { data } = await invoke<TaskDetail>("work.task", { id: "OR-1" }, { sessions: { graphPath: path.join(dir, "absent.sqlite3") } });
    expect(data.sessions).toEqual([]);
    expect(data.sessionsDegraded).toMatchObject({ reason: "graph-missing" });
  });
});

describe("work.taskMentions", () => {
  it("returns every record that mentions the id", async () => {
    const { data } = await invoke<TaskMentions>("work.taskMentions", { id: "OR-1" });
    expect(data).toEqual({ mentions: REFERENCES, degraded: null });
  });

  it("answers degraded, not failing, when context.graph times out", async () => {
    failing = new Set(["context.graph"]);
    const { data, exitCode } = await invoke<TaskMentions>("work.taskMentions", { id: "OR-1" });
    expect(exitCode).toBe(EXIT.OK);
    expect(data.mentions).toEqual([]);
    expect(data.degraded).toContain("aborted due to timeout");
  });

  it("drops a personal initiative's mentions for an export", async () => {
    const { data } = await invoke<TaskMentions>("work.taskMentions", { id: "OR-1" }, { work: { excludePersonal: true } });
    expect(data.mentions.map((mention) => mention.slug)).toEqual(["orbit-relay"]);
  });
});

describe("work.taskArtifacts", () => {
  it("looks up PR state for only the task's own branches, from its initiative's artifacts", async () => {
    const { data } = await invoke<TaskArtifacts>("work.taskArtifacts", { id: "OR-1", slug: "orbit-relay" });
    expect(branchLookups).toEqual([[{ repo: "/synthetic/orbit", name: "pc-or-1-retry" }]]);
    expect(data).toEqual({ branches: [{ repo: "orbit", name: "pc-or-1-retry", present: true, pr: PR_41 }], degraded: [] });
    expect(calls).not.toContain("artifact.status");
  });

  it("asks GitHub nothing when no branch carries the id", async () => {
    const { data } = await invoke<TaskArtifacts>("work.taskArtifacts", { id: "OR-2", slug: "orbit-relay" });
    expect(data).toEqual({ branches: [], degraded: [] });
    expect(branchLookups).toEqual([]);
  });

  it("answers degraded, not failing, when the artifacts cannot be read", async () => {
    failing = new Set(["artifact.list"]);
    const { data, exitCode } = await invoke<TaskArtifacts>("work.taskArtifacts", { id: "OR-1", slug: "orbit-relay" });
    expect(exitCode).toBe(EXIT.OK);
    expect(data).toEqual({ branches: [], degraded: [expect.stringContaining("artifact.list")] });
  });

  it("is not found for a personal initiative in an export", async () => {
    const { exitCode } = await invoke<TaskArtifacts>("work.taskArtifacts", { id: "GP-1", slug: "garden-plan" }, { work: { excludePersonal: true } });
    expect(exitCode).toBe(EXIT.NOINPUT);
    expect(branchLookups).toEqual([]);
  });
});
