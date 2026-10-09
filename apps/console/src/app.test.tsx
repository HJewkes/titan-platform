// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within, type RenderResult } from "@testing-library/react";
import { RpcProvider, embedSnapshot, pageDataSource } from "@titan-design/react-app";
import { SNAPSHOT_FORMAT, snapshotKey, type Snapshot } from "@titan-design/rpc-client";
import { App } from "./App.js";
import { VIEWS } from "./views.js";

afterEach(cleanup);

const HEALTH = {
  checkedAt: "2026-01-02T03:04:05.000Z",
  upstreams: [
    { id: "work", label: "active-work daemon", target: "http://127.0.0.1:7400", reachable: true, detail: "Version 1.2.3" },
    { id: "agents", label: "agent-chat broker", target: "http://127.0.0.1:7600", reachable: false, detail: "No answer from /health" },
    { id: "sessions", label: "session graph", target: "~/data/graph.sqlite3", reachable: true, detail: "2.0 KiB on disk, not opened" },
  ],
};

function snapshotOf(calls: Snapshot["calls"]): Snapshot {
  return { format: SNAPSHOT_FORMAT, createdAt: HEALTH.checkedAt, calls };
}

const healthy = (): Snapshot => snapshotOf({ [snapshotKey("upstreams.health", {})]: { ok: true, data: HEALTH } });

/** Renders the app at a route from a page that carries its snapshot, the way an exported console does. */
function renderConsole(hash: string, snapshot: Snapshot): RenderResult {
  const page = new DOMParser().parseFromString(embedSnapshot("<html><head></head><body></body></html>", snapshot), "text/html");
  window.location.hash = hash;
  return render(
    <RpcProvider source={pageDataSource({ doc: page })}>
      <App />
    </RpcProvider>,
  );
}

describe("the shell", () => {
  it("shows the rail and marks the current one", () => {
    renderConsole("#/sessions", healthy());
    expect(screen.getAllByRole("tab").map((tab) => tab.getAttribute("aria-label"))).toEqual(["Home", "Work", "Tasks", "Sessions", "Agents", "Notes", "Rounds"]);
    // react-ui's NavItem sets no aria-selected on the web, so its accent bar is the only mark of the active item.
    expect(within(screen.getByRole("tab", { name: "Sessions" })).getByTestId("nav-item-accent")).toBeTruthy();
    expect(screen.getAllByTestId("nav-item-accent")).toHaveLength(1);
  });

  it("moves to a view when its nav item is pressed", async () => {
    renderConsole("#/", healthy());
    fireEvent.click(screen.getByRole("tab", { name: "Agents" }));
    await waitFor(() => expect(window.location.hash).toBe("#/agents"));
    expect(await screen.findByText(/spawn tree and message feed/)).toBeTruthy();
  });
});

describe("a planned view", () => {
  const planned = VIEWS.filter((view) => view.planned);

  it.each(planned)("shows a placeholder for $key that names its task", (view) => {
    renderConsole(`#/${view.key}`, healthy());
    expect(screen.getByText(`${view.planned!.summary} Planned in ${view.planned!.tasks}.`)).toBeTruthy();
  });

  it.each(planned)("shows the same placeholder on a $key detail route and keeps its rail entry active", (view) => {
    renderConsole(`#/${view.key}/some-record?tab=graph`, healthy());
    expect(screen.getByText(`${view.planned!.summary} Planned in ${view.planned!.tasks}.`)).toBeTruthy();
    expect(within(screen.getByRole("tab", { name: view.label })).getByTestId("nav-item-accent")).toBeTruthy();
  });
});

describe("the home view", () => {
  it("lists the three upstreams with their reachability", async () => {
    renderConsole("#/", healthy());
    expect(await screen.findByText("active-work daemon")).toBeTruthy();
    expect(screen.getByText("http://127.0.0.1:7600: No answer from /health")).toBeTruthy();
    expect(screen.getByText("~/data/graph.sqlite3: 2.0 KiB on disk, not opened")).toBeTruthy();
    expect(screen.getAllByText("reachable")).toHaveLength(2);
    expect(screen.getAllByText("unreachable")).toHaveLength(1);
  });

  it("shows a loading state before the first answer", () => {
    renderConsole("#/", healthy());
    expect(screen.getByLabelText("Loading upstream health")).toBeTruthy();
  });

  it("says so when the health command fails", async () => {
    renderConsole("#/", snapshotOf({}));
    expect(await screen.findByText(/Could not load upstream health/)).toBeTruthy();
  });
});
