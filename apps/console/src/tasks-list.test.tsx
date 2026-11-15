// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { DETAIL, TASKS, deferred, group, recorded, renderConsole, row, shownIds, snapshotOf, tasksOf } from "./tasks.test-helpers.js";

afterEach(cleanup);

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
    renderConsole("#/tasks?stage=ready", recorded(), { inApp: true });
    fireEvent.change(await screen.findByLabelText("Filter by id or title"), { target: { value: "routing" } });
    await waitFor(() => expect(window.location.hash).toBe("#/tasks?stage=ready&q=routing"));
    expect(shownIds()).toEqual(["OR-4"]);
  });

  it("offers to clear filters that match nothing", async () => {
    renderConsole("#/tasks?q=nothing-like-this", recorded(), { inApp: true });
    expect(await screen.findByText("No tasks match these filters")).toBeTruthy();
    fireEvent.click(screen.getByText("Clear filters"));
    await waitFor(() => expect(window.location.hash).toBe("#/tasks"));
    expect(await screen.findByTestId("task-row-OR-1")).toBeTruthy();
  });

  it("opens a task's detail from its row", async () => {
    renderConsole("#/tasks", recorded(), { inApp: true });
    fireEvent.click(within(await screen.findByTestId("task-row-OR-1")).getByRole("link"));
    await waitFor(() => expect(window.location.hash).toBe("#/tasks/OR-1"));
    expect(await screen.findByText("A dropped handshake retries with backoff.")).toBeTruthy();
  });

  it("shows loading, empty and failed states", async () => {
    renderConsole("#/tasks", recorded());
    expect(screen.getByLabelText("Loading tasks")).toBeTruthy();
    cleanup();
    renderConsole("#/tasks", recorded(tasksOf([])));
    expect(await screen.findByText("No open tasks")).toBeTruthy();
    expect(screen.getByText("No initiative has an open task.")).toBeTruthy();
    cleanup();
    renderConsole("#/tasks", snapshotOf({}));
    expect(await screen.findByText(/Could not load tasks/)).toBeTruthy();
  });

  it("shows the first 50 rows, titles each stage with every match, and loads the rest on the cursor", async () => {
    const many = Array.from({ length: 60 }, (_, n) => row(`OR-${n + 100}`, {}));
    renderConsole("#/tasks", recorded(tasksOf(many), DETAIL, deferred(), many));
    await screen.findByTestId("stage-group-ready");
    expect(shownIds()).toHaveLength(50);
    expect(within(group("ready")).getByText("Ready (60)")).toBeTruthy();
    expect(within(group("ready")).getByText("Showing 50 of 60 by priority; load more or filter to see the rest.")).toBeTruthy();
    fireEvent.click(screen.getByText("Load more (50 of 60 shown)"));
    await screen.findByTestId("task-row-OR-159");
    expect(shownIds()).toEqual(many.map((entry) => entry.id));
    expect(screen.queryByText(/^Load more/)).toBeNull();
    expect(within(group("ready")).queryByText(/^Showing/)).toBeNull();
  });

  it("warns when stage evidence is degraded", async () => {
    renderConsole("#/tasks", recorded({ ...TASKS, evidence: { repos: [], degraded: ["Open pull requests in example/orbit unread: offline"] } }));
    expect(await screen.findByText(/Some stages lack evidence: Open pull requests in example\/orbit unread/)).toBeTruthy();
  });
});
