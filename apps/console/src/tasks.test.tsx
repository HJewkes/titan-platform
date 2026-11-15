// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { errorEnvelope, successEnvelope } from "@titan-design/registry";
import { snapshotKey } from "@titan-design/rpc-client";
import { DETAIL, SESSION, TASKS, type TaskDetail, deferred, heldSource, recorded, renderConsole, rosterAgent, rosterOf, snapshotOf } from "./tasks.test-helpers.js";

afterEach(cleanup);


describe("a task's detail", () => {
  it("shows the task record with its stage, done-when and notes", async () => {
    renderConsole("#/tasks/OR-1", recorded());
    expect(await screen.findByText("OR-1 Retry a dropped handshake")).toBeTruthy();
    expect(screen.getByText("In review")).toBeTruthy();
    expect(screen.getByText("PR example/orbit#41 is open (head pc-or-1-retry)")).toBeTruthy();
    expect(screen.getByText("Backoff caps at thirty seconds.")).toBeTruthy();
  });

  it("renders the shell first, then fills in branch pull requests and mentions", async () => {
    const { source, held, release } = heldSource(recorded());
    renderConsole("#/tasks/OR-1", source);
    expect(await screen.findByText("OR-1 Retry a dropped handshake")).toBeTruthy();
    expect(screen.getByLabelText("Loading branch pull requests")).toBeTruthy();
    expect(screen.getByLabelText("Loading mentions")).toBeTruthy();
    expect(held.sort()).toEqual(["work.taskArtifacts", "work.taskMentions"]);
    release();
    expect(await screen.findByText(/^#41 OR-1: Retry/)).toBeTruthy();
    expect(await screen.findByText("orbit-relay OR-7")).toBeTruthy();
  });

  it("keeps the page and marks each deferred section unavailable when its read fails", async () => {
    renderConsole("#/tasks/OR-1", recorded(TASKS, DETAIL, {}));
    expect(await screen.findByText(/^Branch pull requests are unavailable:/)).toBeTruthy();
    expect(await screen.findByText(/^Mentions are unavailable:/)).toBeTruthy();
    expect(screen.getByText("OR-1 Retry a dropped handshake")).toBeTruthy();
    expect(screen.getByText(/^example\/orbit#41/)).toBeTruthy();
  });

  it("shows a degraded deferred answer as unavailable, not as empty", async () => {
    renderConsole("#/tasks/OR-1", recorded(TASKS, DETAIL, deferred({ mentions: [], degraded: "Mentions unread: timeout" }, { branches: [], degraded: ["Pull requests in example/orbit unread: offline"] })));
    expect(await screen.findByText("Mentions are unavailable: Mentions unread: timeout")).toBeTruthy();
    expect(await screen.findByText("Branch pull requests are unavailable: Pull requests in example/orbit unread: offline.")).toBeTruthy();
    expect(screen.queryByText("No record mentions this task.")).toBeNull();
  });

  it("shows pull request state from the artifacts and open pull requests", async () => {
    renderConsole("#/tasks/OR-1", recorded());
    expect(await screen.findByText(/^example\/orbit#41/)).toBeTruthy();
    expect(await screen.findByText(/^#41 OR-1: Retry/)).toBeTruthy();
    expect(screen.getByText("checks pass (3/3)")).toBeTruthy();
  });

  it("links a mention to the task that makes it", async () => {
    renderConsole("#/tasks/OR-1", recorded(), { inApp: true });
    fireEvent.click(await screen.findByText("orbit-relay OR-7"));
    await waitFor(() => expect(window.location.hash).toBe("#/tasks/OR-7"));
  });

  it("links each linked session and its agent", async () => {
    renderConsole("#/tasks/OR-1", recorded(), { inApp: true });
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

  it("links the parent, each dependency and each open child to its task page, with the child's status", async () => {
    const related: TaskDetail = {
      ...DETAIL,
      task: { ...DETAIL.task, parent: "OR-10", dep: ["OR-11"] },
      children: [{ id: "OR-12", title: "Child work", status: "open" }],
    };
    for (const id of ["OR-10", "OR-11", "OR-12"]) {
      renderConsole("#/tasks/OR-1", recorded(TASKS, related), { inApp: true });
      const panel = await screen.findByTestId("related-panel");
      expect(within(panel).getByText("open")).toBeTruthy();
      fireEvent.click(within(panel).getByText(new RegExp(`^${id}`)));
      await waitFor(() => expect(window.location.hash).toBe(`#/tasks/${id}`));
      cleanup();
    }
  });

  it("names a deliverable's record title, or says it has no record", async () => {
    const record = { id: "D-1", title: "Handshake guide", status: "active" as const, target: null, owner_seat: "docs", tags: [], tasks: { open: 1, done: 0 } };
    renderConsole("#/tasks/OR-1", recorded(TASKS, { ...DETAIL, deliverables: [{ id: "D-1", record }, { id: "D-2", record: null }] }));
    const panel = await screen.findByTestId("related-panel");
    expect(within(panel).getByText("D-1 Handshake guide")).toBeTruthy();
    expect(within(panel).getByText("D-2 no record")).toBeTruthy();
  });

  it("warns when the deliverable registry is degraded", async () => {
    renderConsole("#/tasks/OR-1", recorded(TASKS, { ...DETAIL, deliverablesDegraded: "daemon too old" }));
    expect(await screen.findByText("Deliverables are unavailable: daemon too old")).toBeTruthy();
  });

  it("says when a task has no related tasks", async () => {
    renderConsole("#/tasks/OR-1", recorded());
    expect(await screen.findByText("No related tasks")).toBeTruthy();
  });

  it("lists the agents working the task, each linking to its agent page", async () => {
    const roster = rosterOf([rosterAgent("impl-a", "OR-1"), rosterAgent("impl-b", "OR-2")]);
    renderConsole("#/tasks/OR-1", recorded(TASKS, DETAIL, { ...deferred(), [snapshotKey("agents.roster", {})]: successEnvelope(roster) }), { inApp: true });
    const section = await screen.findByTestId("task-agents");
    expect(await within(section).findByText("impl-a")).toBeTruthy();
    expect(within(section).queryByText("impl-b")).toBeNull();
    expect(within(section).getByText("working")).toBeTruthy();
    fireEvent.click(within(section).getByText("impl-a"));
    await waitFor(() => expect(window.location.hash).toBe("#/agents/impl-a"));
  });

  it("says when no agent works the task", async () => {
    const roster = rosterOf([rosterAgent("impl-b", "OR-2")]);
    renderConsole("#/tasks/OR-1", recorded(TASKS, DETAIL, { ...deferred(), [snapshotKey("agents.roster", {})]: successEnvelope(roster) }));
    expect(await screen.findByText("No live agent on this task")).toBeTruthy();
  });

  it("warns when the agent roster cannot be read", async () => {
    renderConsole("#/tasks/OR-1", recorded(TASKS, DETAIL, { ...deferred(), [snapshotKey("agents.roster", {})]: errorEnvelope("broker down", 69) }));
    expect(await screen.findByText(/^Agents are unavailable: broker down/)).toBeTruthy();
    expect(screen.queryByText("No live agent on this task")).toBeNull();
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
    renderConsole("#/tasks/OR-1", recorded(), { inApp: true });
    fireEvent.click(await screen.findByRole("link", { name: "Tasks" }));
    await waitFor(() => expect(window.location.hash).toBe("#/tasks"));
  });
});
