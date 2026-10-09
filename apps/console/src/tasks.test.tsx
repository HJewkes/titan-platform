// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { RpcProvider, embedSnapshot, pageDataSource } from "@titan-design/react-app";
import { EXIT, errorEnvelope, successEnvelope } from "@titan-design/registry";
import { SNAPSHOT_FORMAT, snapshotKey, type Snapshot } from "@titan-design/rpc-client";
import type { ConsoleCommands } from "../server/commands.js";
import { App } from "./App.js";

afterEach(cleanup);

type TasksResult = ConsoleCommands["work.tasks"]["result"];
type TaskDetail = ConsoleCommands["work.task"]["result"];
type Row = TasksResult["tasks"][number];

// Synthetic rows in `work.tasks` shape; nothing here comes from a real workspace.
const row = (id: string, fields: Partial<Row>): Row => ({
  slug: "orbit-relay", id, title: `Task ${id}`, priority: 1, updated: "2031-03-01", status: "open",
  stage: "ready", stageRule: "default", stageReason: "No pull request, live branch, worktree, open dependency or hold found", stageGuessed: true, ...fields,
});

const TASKS: TasksResult = {
  fetchedAt: "2031-03-05T00:00:00.000Z",
  evidence: { repos: ["example/orbit"], degraded: [] },
  tasks: [
    row("OR-1", { title: "Retry a dropped handshake", severity: "critical", stage: "review", stageRule: "open-pr", stageReason: "PR example/orbit#41 is open (head pc-or-1-retry)", stageGuessed: false }),
    row("OR-2", { title: "Report queue depth", severity: "high", stage: "blocked", stageRule: "dependency", stageReason: "Depends on OR-5 (open)", stageGuessed: false }),
    row("OR-4", { title: "Document the routing table", severity: "low" }),
    row("LD-3", { slug: "lantern-docs", title: "Merge the battery chapters", severity: "medium", stage: "in-progress", stageRule: "live-ref", stageReason: "Worktree on branch pc-ld-3 in example/lantern", stageGuessed: false }),
  ],
};

const SESSION = "0a1b2c3d-0000-4000-8000-0000000000aa";

const DETAIL: TaskDetail = {
  fetchedAt: "2031-03-05T00:00:00.000Z",
  task: { ...TASKS.tasks[0]!, notes: "Backoff caps at thirty seconds.", doneWhen: "A dropped handshake retries with backoff." },
  mentions: [{ slug: "orbit-relay", source: "task", file: "tasks/OR-7.yml", field: "notes", text: "Follows OR-1" }],
  artifacts: {
    branches: [{ repo: "orbit", name: "pc-or-1-retry", present: true, pr: { number: 41, state: "OPEN", title: "OR-1: Retry", url: "https://example.invalid/41", checks: "pass (3/3)" } }],
    worktrees: [],
  },
  refs: [],
  openPrs: [{ repo: "example/orbit", number: 41, headRef: "pc-or-1-retry" }],
  sessions: [{
    sessionId: SESSION, title: "Handshake retry run", startedAt: "2031-03-01T10:00:00Z", endedAt: null, cwd: null, gitBranch: null, turnCount: 3,
    transcript: null, agentName: "impl-a", parentSessionId: null, taskIds: ["OR-1"], prs: [], usage: [], costUsd: 0,
  }],
  sessionsDegraded: null,
  evidence: { repos: ["example/orbit"], degraded: [] },
};

function snapshotOf(calls: Snapshot["calls"]): Snapshot {
  return { format: SNAPSHOT_FORMAT, createdAt: "2031-03-05T00:00:00.000Z", calls };
}

const recorded = (tasks: TasksResult = TASKS, detail: TaskDetail = DETAIL): Snapshot =>
  snapshotOf({
    [snapshotKey("work.tasks", {})]: successEnvelope(tasks),
    [snapshotKey("work.task", { id: "OR-1" })]: successEnvelope(detail),
    [snapshotKey("work.task", { id: "OR-404" })]: errorEnvelope("No task OR-404 in any initiative", EXIT.NOINPUT),
  });

function renderConsole(hash: string, snapshot: Snapshot): void {
  const page = new DOMParser().parseFromString(embedSnapshot("<html><head></head><body></body></html>", snapshot), "text/html");
  window.location.hash = hash;
  render(
    <RpcProvider source={pageDataSource({ doc: page })}>
      <App />
    </RpcProvider>,
  );
}

const group = (stage: string): HTMLElement => screen.getByTestId(`stage-group-${stage}`);
const shownIds = (): string[] => screen.queryAllByTestId(/^task-row-/).map((element) => element.getAttribute("data-testid")!.slice("task-row-".length));

describe("the tasks list", () => {
  it("groups open tasks by stage in board order", async () => {
    renderConsole("#/tasks", recorded());
    await screen.findByTestId("stage-group-blocked");
    expect(screen.getAllByTestId(/^stage-group-/).map((element) => element.getAttribute("data-testid"))).toEqual(["stage-group-blocked", "stage-group-ready", "stage-group-in-progress", "stage-group-review"]);
    expect(within(group("review")).getByText("In review (1)")).toBeTruthy();
    expect(within(group("blocked")).getByText("Depends on OR-5 (open)")).toBeTruthy();
  });

  it("captions a guessed stage and only that one", async () => {
    renderConsole("#/tasks", recorded());
    await screen.findByTestId("task-row-OR-4");
    expect(within(screen.getByTestId("task-row-OR-4")).getByText("Stage guessed: no stage signal on this task")).toBeTruthy();
    expect(screen.getAllByText("Stage guessed: no stage signal on this task")).toHaveLength(1);
  });

  it("applies stage, initiative, severity and text filters from the query string", async () => {
    renderConsole("#/tasks?stage=in-progress&initiative=lantern-docs", recorded());
    await screen.findByTestId("task-row-LD-3");
    expect(shownIds()).toEqual(["LD-3"]);
    cleanup();
    renderConsole("#/tasks?severity=critical&q=handshake", recorded());
    await screen.findByTestId("task-row-OR-1");
    expect(shownIds()).toEqual(["OR-1"]);
  });

  it("keeps typed filter text in the query string", async () => {
    renderConsole("#/tasks?stage=ready", recorded());
    fireEvent.change(await screen.findByLabelText("Filter by id or title"), { target: { value: "routing" } });
    await waitFor(() => expect(window.location.hash).toBe("#/tasks?stage=ready&q=routing"));
    expect(shownIds()).toEqual(["OR-4"]);
  });

  it("offers to clear filters that match nothing", async () => {
    renderConsole("#/tasks?q=nothing-like-this", recorded());
    expect(await screen.findByText("No tasks match these filters")).toBeTruthy();
    fireEvent.click(screen.getByText("Clear filters"));
    await waitFor(() => expect(window.location.hash).toBe("#/tasks"));
    expect(await screen.findByTestId("task-row-OR-1")).toBeTruthy();
  });

  it("opens a task's detail from its row", async () => {
    renderConsole("#/tasks", recorded());
    fireEvent.click(within(await screen.findByTestId("task-row-OR-1")).getByRole("link"));
    await waitFor(() => expect(window.location.hash).toBe("#/tasks/OR-1"));
    expect(await screen.findByText("A dropped handshake retries with backoff.")).toBeTruthy();
  });

  it("shows loading, empty and failed states", async () => {
    renderConsole("#/tasks", recorded());
    expect(screen.getByLabelText("Loading tasks")).toBeTruthy();
    cleanup();
    renderConsole("#/tasks", recorded({ ...TASKS, tasks: [] }));
    expect(await screen.findByText("No open tasks")).toBeTruthy();
    expect(screen.getByText("No initiative has an open task.")).toBeTruthy();
    cleanup();
    renderConsole("#/tasks", snapshotOf({}));
    expect(await screen.findByText(/Could not load tasks/)).toBeTruthy();
  });

  it("warns when stage evidence is degraded", async () => {
    renderConsole("#/tasks", recorded({ ...TASKS, evidence: { repos: [], degraded: ["Open pull requests in example/orbit unread: offline"] } }));
    expect(await screen.findByText(/Some stages lack evidence: Open pull requests in example\/orbit unread/)).toBeTruthy();
  });
});

describe("a task's detail", () => {
  it("shows the task record with its stage, done-when and notes", async () => {
    renderConsole("#/tasks/OR-1", recorded());
    expect(await screen.findByText("OR-1 Retry a dropped handshake")).toBeTruthy();
    expect(screen.getByText("In review")).toBeTruthy();
    expect(screen.getByText("PR example/orbit#41 is open (head pc-or-1-retry)")).toBeTruthy();
    expect(screen.getByText("Backoff caps at thirty seconds.")).toBeTruthy();
  });

  it("shows pull request state from the artifacts and open pull requests", async () => {
    renderConsole("#/tasks/OR-1", recorded());
    expect(await screen.findByText(/^example\/orbit#41/)).toBeTruthy();
    expect(screen.getByText(/^#41 OR-1: Retry/)).toBeTruthy();
    expect(screen.getByText("checks pass (3/3)")).toBeTruthy();
  });

  it("links a mention to the task that makes it", async () => {
    renderConsole("#/tasks/OR-1", recorded());
    fireEvent.click(await screen.findByText("orbit-relay OR-7"));
    await waitFor(() => expect(window.location.hash).toBe("#/tasks/OR-7"));
  });

  it("links each linked session and its agent", async () => {
    renderConsole("#/tasks/OR-1", recorded());
    const session = await screen.findByTestId(`session-${SESSION}`);
    fireEvent.click(within(session).getByText("impl-a"));
    await waitFor(() => expect(window.location.hash).toBe("#/agents/impl-a"));
    cleanup();
    renderConsole("#/tasks/OR-1", recorded());
    fireEvent.click(await screen.findByText("Handshake retry run"));
    await waitFor(() => expect(window.location.hash).toBe(`#/sessions/${SESSION}`));
  });

  it("says when no session names the task, and when session links are unavailable", async () => {
    renderConsole("#/tasks/OR-1", recorded(TASKS, { ...DETAIL, sessions: [] }));
    expect(await screen.findByText("No session names this task.")).toBeTruthy();
    cleanup();
    renderConsole("#/tasks/OR-1", recorded(TASKS, { ...DETAIL, sessions: [], sessionsDegraded: { reason: "graph-missing", detail: "No session graph at the configured path" } }));
    expect(await screen.findByText("Session links are unavailable: No session graph at the configured path")).toBeTruthy();
  });

  it("warns when pull request state is unavailable", async () => {
    renderConsole("#/tasks/OR-1", recorded(TASKS, { ...DETAIL, evidence: { repos: [], degraded: ["GitHub unreachable"] } }));
    expect(await screen.findByText("Pull request state is unavailable: GitHub unreachable.")).toBeTruthy();
  });

  it("shows loading, not-found and failed states", async () => {
    renderConsole("#/tasks/OR-1", recorded());
    expect(screen.getByLabelText("Loading task")).toBeTruthy();
    cleanup();
    renderConsole("#/tasks/OR-404", recorded());
    expect(await screen.findByText("No task named OR-404")).toBeTruthy();
    cleanup();
    renderConsole("#/tasks/OR-1", snapshotOf({}));
    expect(await screen.findByText(/Could not load OR-1:/)).toBeTruthy();
  });

  it("returns to the list from the breadcrumb", async () => {
    renderConsole("#/tasks/OR-1", recorded());
    fireEvent.click(await screen.findByRole("link", { name: "Tasks" }));
    await waitFor(() => expect(window.location.hash).toBe("#/tasks"));
  });
});
