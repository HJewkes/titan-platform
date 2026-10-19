// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { RpcProvider, embedSnapshot, pageDataSource } from "@titan-design/react-app";
import { errorEnvelope, successEnvelope } from "@titan-design/registry";
import { SNAPSHOT_FORMAT, snapshotKey, type Snapshot } from "@titan-design/rpc-client";
import { App } from "./App.js";

afterEach(cleanup);

const SEAT_FILE = "/srv/fleet/autonomy/seats/seat-k.md";
const AC_FILE = "/srv/fleet/Agent Home/config.json";
const SECRET = "synthetic-secret-7f3a";

function file(surface: string, kind: string, group: string, path: string): Record<string, unknown> {
  return { surface, kind, group, inventory: 1, file: path, mtime: "2031-03-05T00:00:00.000Z", newestBackup: null };
}

const FILES = [
  file("seat:seat-k", "seat", "coordinator", SEAT_FILE),
  file("agent-chat-config", "agent-chat-config", "agent-chat", AC_FILE),
  file("console-env", "console-env", "console", "process environment"),
];

const ROWS = [
  { surface: "seat:seat-k", file: SEAT_FILE, field: "concurrency.implementers", line: 17, hidden: false, value: 20, comment: "# owner decision 446", decisions: ["446"] },
  // A hidden row never carries a value from the server; this one does, so the page's own refusal is what the test sees.
  { surface: "seat:seat-k", file: SEAT_FILE, field: "notify_secret", line: 19, hidden: true, value: SECRET, decisions: [] },
  { surface: "agent-chat-config", file: AC_FILE, field: "worktreeBudget", line: 3, hidden: false, value: 12, decisions: [] },
  { surface: "console-env", file: "process environment", field: "TITAN_CONSOLE_PORT", line: 0, hidden: false, value: "7420", decisions: [] },
];

const DRIFT = {
  rows: [
    { id: "load-hold", label: "Load hold (load5)", status: "agree", values: [40], sources: [], absent: [] },
    {
      id: "worktrees-per-repo",
      label: "Worktree cap per repo",
      status: "drift",
      values: [12, 32],
      sources: [
        { surface: "agent-chat-config", field: "worktreeBudget", file: AC_FILE, line: 3, value: 12 },
        { surface: "burndown", field: "maxWorktreesPerRepo", file: "/srv/fleet/burndown.json", line: 4, value: 32 },
      ],
      absent: [{ surface: "claude-md", field: "worktreesPerRepo" }],
    },
  ],
  gaps: [],
};

function snapshot(calls: Snapshot["calls"]): Snapshot {
  return { format: SNAPSHOT_FORMAT, createdAt: "2031-03-05T00:00:00.000Z", calls };
}

const SURFACES_KEY = snapshotKey("config.surfaces", {});
const DRIFT_KEY = snapshotKey("config.drift", {});

const RECORDED = snapshot({
  [SURFACES_KEY]: successEnvelope({ files: FILES, rows: ROWS, gaps: ["/srv/fleet/factory.json: missing"] }),
  [DRIFT_KEY]: successEnvelope(DRIFT),
});

function renderConsole(recorded: Snapshot = RECORDED): void {
  const page = new DOMParser().parseFromString(embedSnapshot("<html><head></head><body></body></html>", recorded), "text/html");
  window.location.hash = "#/config";
  render(
    <RpcProvider source={pageDataSource({ doc: page })}>
      <App />
    </RpcProvider>,
  );
}

describe("the config page", () => {
  it("shows a terminal row's exact command, quoting a path with a space", async () => {
    renderConsole();
    const seat = await screen.findByTestId("config-row-seat:seat-k-concurrency.implementers");
    expect(within(seat).getByTestId("config-row-command").textContent).toBe(`"\${EDITOR:-vi}" +17 '${SEAT_FILE}'`);
    expect(within(seat).getByText("terminal")).toBeTruthy();
    expect(within(seat).getByText("20")).toBeTruthy();
    expect(within(seat).getByText("decision 446")).toBeTruthy();
    const budget = screen.getByTestId("config-row-agent-chat-config-worktreeBudget");
    expect(within(budget).getByTestId("config-row-command").textContent).toBe(`"\${EDITOR:-vi}" +3 '/srv/fleet/Agent Home/config.json'`);
  });

  it("shows a secret row as present and never its value", async () => {
    renderConsole();
    const secret = await screen.findByTestId("config-row-seat:seat-k-notify_secret");
    expect(within(secret).getByTestId("config-row-present").textContent).toBe("present");
    expect(within(secret).getByText("read-only")).toBeTruthy();
    expect(within(secret).queryByTestId("config-row-command")).toBeNull();
    expect(document.body.textContent).not.toContain(SECRET);
  });

  it("leads with drift, before the agreeing copies and every surface group", async () => {
    renderConsole();
    const drift = await screen.findByTestId("config-drift");
    expect(within(drift).getByText("Drift (1)")).toBeTruthy();
    expect(within(drift).getByText("agent-chat-config worktreeBudget = 12")).toBeTruthy();
    expect(within(drift).getByText("burndown maxWorktreesPerRepo = 32")).toBeTruthy();
    expect(within(drift).getByText(/Not on this host or hidden: claude-md worktreesPerRepo/)).toBeTruthy();
    expect(within(drift).queryByText("Load hold (load5)")).toBeNull();
    const order = ["config-drift", "config-agree", "config-group-Coordinator", "config-group-agent-chat", "config-group-Console", "config-gaps"].map((id) => screen.getByTestId(id));
    for (const [index, section] of order.slice(1).entries()) expect(order[index]!.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("groups every row under its surface", async () => {
    renderConsole();
    const coordinator = await screen.findByTestId("config-group-Coordinator");
    expect(within(coordinator).getByTestId("config-surface-seat:seat-k")).toBeTruthy();
    expect(within(screen.getByTestId("config-group-Console")).getByText("TITAN_CONSOLE_PORT")).toBeTruthy();
    expect(screen.getAllByTestId(/^config-row-(?!command|present)/)).toHaveLength(ROWS.length);
  });

  it("gives an environment row no command, since no file line holds it", async () => {
    renderConsole();
    const env = await screen.findByTestId("config-row-console-env-TITAN_CONSOLE_PORT");
    expect(within(env).queryByTestId("config-row-command")).toBeNull();
    expect(within(env).getByText(/next restart/)).toBeTruthy();
  });

  it("offers no control that edits; copy is the only button", async () => {
    Object.defineProperty(navigator, "clipboard", { value: { writeText: () => Promise.resolve() }, configurable: true });
    renderConsole();
    await screen.findByTestId("config-drift");
    const labels = screen.queryAllByRole("button").map((button) => button.textContent);
    expect(labels.filter((label) => /edit|save|apply|set/i.test(label))).toHaveLength(0);
    fireEvent.click(within(screen.getByTestId("config-row-agent-chat-config-worktreeBudget")).getByText("Copy command"));
    await waitFor(() => expect(within(screen.getByTestId("config-row-agent-chat-config-worktreeBudget")).getByText("Copied")).toBeTruthy());
    Reflect.deleteProperty(navigator, "clipboard");
  });

  it("shows each read's error when the daemon does not answer", async () => {
    renderConsole(snapshot({ [SURFACES_KEY]: errorEnvelope("config read failed", 70), [DRIFT_KEY]: errorEnvelope("drift read failed", 70) }));
    expect(await screen.findByText(/Could not load config: .*config read failed/)).toBeTruthy();
    expect(screen.getByText(/Could not load config drift: .*drift read failed/)).toBeTruthy();
  });
});
