// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { RpcProvider, embedSnapshot, pageDataSource } from "@titan-design/react-app";
import { errorEnvelope, successEnvelope } from "@titan-design/registry";
import { SNAPSHOT_FORMAT, snapshotKey, type Snapshot } from "@titan-design/rpc-client";
import type { ConsoleCommands } from "../server/commands.js";
import { App } from "./App.js";

afterEach(cleanup);

type Roster = ConsoleCommands["agents.roster"]["result"];
type RosterEntry = Roster["agents"][number];
type Messages = ConsoleCommands["agents.messages"]["result"];
type Message = Messages["messages"][number];
type Sessions = ConsoleCommands["sessions.list"]["result"];
type Session = Sessions["sessions"][number];

const BROKER_DOWN = "agent-chat broker not answering on port 7600: connect ECONNREFUSED";

function agent(name: string, overrides: Partial<RosterEntry> = {}): RosterEntry {
  return {
    id: `${name}@1`, idSource: "nameAtRegisteredAt", name, agentId: null, state: "working", stateSource: "presence", origin: "spawned",
    workingOn: null, cwd: null, gitBranch: null, seat: null, surface: null, profile: null, taskId: null, spawnedBy: null, claudeSessionId: null,
    registeredAt: 1_000, spawnedAt: null, lastEventAt: 9_000, idleMs: 0, dnd: false, provisional: false, tags: [], costUsd: null, costSource: null,
    ...overrides,
  };
}

const ROSTER: Roster = {
  agents: [
    agent("harbor-coord", { workingOn: "Steer the harbor build" }),
    agent("harbor-impl", { state: "exited", stateSource: "history", spawnedBy: "harbor-coord", taskId: "HB-7", costUsd: 1.25, workingOn: "Build the dock index" }),
  ],
  brokerUptimeMs: 60_000,
  reconnecting: false,
  history: { events: 40, limit: 1000, oldestAt: 1_000 },
  generatedAt: 10_000,
};

function message(msgId: string, from: string, to: string, text: string, at: number): Message {
  return { id: null, msgId, kind: "message", from, to, text, at, ref: null, meta: {} };
}

const IMPL_MESSAGES = [message("m2", "harbor-impl", "harbor-coord", "Dock index merged", 8_000), message("m1", "harbor-coord", "harbor-impl", "Start on the dock index", 7_000)];
const ALL_MESSAGES = [message("m3", "harbor-coord", "lantern-seat", "Harbor is green", 9_000), ...IMPL_MESSAGES];

function messages(rows: Message[]): Messages {
  return { messages: rows, source: "events-db", partial: false, nextCursor: null, history: null };
}

function session(sessionId: string, title: string): Session {
  return {
    sessionId, title, startedAt: "2031-03-04T10:00:00.000Z", endedAt: "2031-03-04T10:30:00.000Z", cwd: null, gitBranch: null, turnCount: 12,
    transcript: null, agentName: "harbor-impl", parentSessionId: null, taskIds: ["HB-7"], prs: [], usage: [], costUsd: 0.5,
  };
}

const runsKey = (name: string) => snapshotKey("sessions.list", { agent: name, limit: 50 });
const feedKey = (name?: string) => snapshotKey("agents.messages", name === undefined ? { limit: 200 } : { agent: name, limit: 200 });

function snapshot(calls: Snapshot["calls"]): Snapshot {
  return { format: SNAPSHOT_FORMAT, createdAt: "2031-03-05T00:00:00.000Z", calls };
}

function healthy(): Snapshot {
  return snapshot({
    [snapshotKey("agents.roster", {})]: successEnvelope(ROSTER),
    [feedKey()]: successEnvelope(messages(ALL_MESSAGES)),
    [feedKey("harbor-impl")]: successEnvelope(messages(IMPL_MESSAGES)),
    [feedKey("harbor-coord")]: successEnvelope(messages([])),
    [runsKey("harbor-impl")]: successEnvelope({ sessions: [session("run-1", "Dock index build")], nextBefore: null, degraded: null }),
    [runsKey("harbor-coord")]: successEnvelope({ sessions: [], nextBefore: null, degraded: null }),
    [runsKey("ghost")]: successEnvelope({ sessions: [], nextBefore: null, degraded: null }),
  });
}

function brokerDown(): Snapshot {
  return snapshot({
    [snapshotKey("agents.roster", {})]: errorEnvelope(BROKER_DOWN, 69),
    [feedKey()]: errorEnvelope(BROKER_DOWN, 69),
  });
}

function renderConsole(hash: string, recorded: Snapshot): void {
  const page = new DOMParser().parseFromString(embedSnapshot("<html><head></head><body></body></html>", recorded), "text/html");
  window.location.hash = hash;
  render(
    <RpcProvider source={pageDataSource({ doc: page })}>
      <App />
    </RpcProvider>,
  );
}

describe("the agents view", () => {
  it("lists the roster with each agent's state, spawner and cost", async () => {
    renderConsole("#/agents", healthy());
    const impl = await screen.findByTestId("agent-row-harbor-impl");
    expect(within(impl).getByText("exited")).toBeTruthy();
    expect(within(impl).getByText("harbor-coord")).toBeTruthy();
    expect(within(impl).getByText("$1.25")).toBeTruthy();
    expect(within(screen.getByTestId("agent-row-harbor-coord")).getByText("Steer the harbor build")).toBeTruthy();
  });

  it("shows every agent's messages, newest first, under the window caption", async () => {
    renderConsole("#/agents?tab=messages", healthy());
    expect(await screen.findByText("Counted over the broker's last 1,000 events.")).toBeTruthy();
    const rows = screen.getAllByTestId(/^message-/).map((row) => row.getAttribute("data-testid"));
    expect(rows).toEqual(["message-m3", "message-m2", "message-m1"]);
    expect(screen.getByText("harbor-coord → lantern-seat")).toBeTruthy();
  });

  it("switches tabs through the query string", async () => {
    renderConsole("#/agents", healthy());
    await screen.findByTestId("agent-row-harbor-impl");
    fireEvent.click(screen.getByText("Messages"));
    await waitFor(() => expect(window.location.hash).toBe("#/agents?tab=messages"));
    expect(await screen.findByText("Harbor is green")).toBeTruthy();
  });

  it("says the broker knows no agents", async () => {
    renderConsole("#/agents", snapshot({ [snapshotKey("agents.roster", {})]: successEnvelope({ ...ROSTER, agents: [] }) }));
    expect(await screen.findByText("No agents")).toBeTruthy();
    expect(screen.getByText("The agent-chat broker knows no agents.")).toBeTruthy();
  });

  it("says the feed is empty over the broker's window", async () => {
    renderConsole("#/agents?tab=messages", snapshot({ [feedKey()]: successEnvelope(messages([])) }));
    expect(await screen.findByText("No messages in the broker's last 1,000 events.")).toBeTruthy();
  });

  it.each(["", "?tab=messages"])("names the broker failure on %s", async (query) => {
    renderConsole(`#/agents${query}`, brokerDown());
    expect(await screen.findByText(`Could not load agents: ${BROKER_DOWN}`)).toBeTruthy();
  });

  it("opens an agent from its roster row", async () => {
    renderConsole("#/agents", healthy());
    fireEvent.click(within(await screen.findByTestId("agent-row-harbor-impl")).getByRole("link"));
    await waitFor(() => expect(window.location.hash).toBe("#/agents/harbor-impl"));
    expect(await screen.findByTestId("agent-card")).toBeTruthy();
  });
});

describe("an agent's detail", () => {
  it("shows its card and its runs from the session graph", async () => {
    renderConsole("#/agents/harbor-impl", healthy());
    const card = await screen.findByTestId("agent-card");
    expect(within(card).getByText("Build the dock index")).toBeTruthy();
    expect(within(card).getByText("Spawned by harbor-coord · Task HB-7 · Cost $1.25")).toBeTruthy();
    const run = await screen.findByTestId("run-row-run-1");
    expect(within(run).getByText("Dock index build")).toBeTruthy();
    expect(within(run).getByText("HB-7")).toBeTruthy();
  });

  it("opens a run's session", async () => {
    renderConsole("#/agents/harbor-impl", healthy());
    fireEvent.click(within(await screen.findByTestId("run-row-run-1")).getByRole("link"));
    await waitFor(() => expect(window.location.hash).toBe("#/sessions/run-1"));
  });

  it("lists only its own messages under the Messages tab", async () => {
    renderConsole("#/agents/harbor-impl?tab=messages", healthy());
    expect(await screen.findByText("Dock index merged")).toBeTruthy();
    expect(screen.queryByText("Harbor is green")).toBeNull();
    expect(screen.getByText("Counted over the broker's last 1,000 events.")).toBeTruthy();
  });

  it("says when it has no runs and no messages", async () => {
    renderConsole("#/agents/harbor-coord", healthy());
    expect(await screen.findByText("No sessions recorded for harbor-coord.")).toBeTruthy();
    fireEvent.click(screen.getByText("Messages"));
    expect(await screen.findByText("No messages to or from harbor-coord in the broker's last 1,000 events.")).toBeTruthy();
  });

  it("says an unknown agent is not in the broker's roster or window", async () => {
    renderConsole("#/agents/ghost", healthy());
    expect(await screen.findByText("No agent named ghost in the broker's roster or its last 1,000 events.")).toBeTruthy();
  });

  it("warns on the Runs tab when the session graph is missing", async () => {
    const recorded = healthy();
    recorded.calls[runsKey("harbor-impl")] = successEnvelope({ sessions: [], nextBefore: null, degraded: { reason: "graph-missing", detail: "No session graph at /data/graph.sqlite3" } });
    renderConsole("#/agents/harbor-impl", recorded);
    expect(await screen.findByText(/The session list is unavailable: the session graph is missing/)).toBeTruthy();
  });

  it("names the broker failure", async () => {
    renderConsole("#/agents/harbor-impl", brokerDown());
    expect(await screen.findByText(`Could not load agents: ${BROKER_DOWN}`)).toBeTruthy();
  });

  it("returns to the roster from the breadcrumb", async () => {
    renderConsole("#/agents/harbor-impl", healthy());
    fireEvent.click(await screen.findByRole("link", { name: "Agents" }));
    await waitFor(() => expect(window.location.hash).toBe("#/agents"));
  });
});
