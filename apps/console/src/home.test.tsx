// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { RpcProvider, embedSnapshot, pageDataSource } from "@titan-design/react-app";
import { errorEnvelope, successEnvelope, type JsonEnvelope } from "@titan-design/registry";
import { SNAPSHOT_FORMAT, snapshotKey, type DataSource, type Snapshot } from "@titan-design/rpc-client";
import { App } from "./App.js";

// Local noon, so "today" and "the last 24 hours" never straddle midnight whatever zone the test runs in.
const NOW = new Date(2031, 2, 5, 12, 0, 0).getTime();
const HOUR = 60 * 60 * 1000;
const ago = (ms: number): string => new Date(NOW - ms).toISOString();

const upstream = (id: string, label: string, target: string, reachable = true, detail = "ok") => ({ id, label, target, reachable, detail });

const HEALTHY = [
  upstream("work", "active-work daemon", "http://127.0.0.1:7400", true, "Version 1.2.3"),
  upstream("agents", "agent-chat broker", "http://127.0.0.1:7600", true, "Version 4.5.6"),
  upstream("sessions", "session graph", "~/data/graph.sqlite3", true, "2.0 KiB on disk, not opened"),
];

const initiative = (slug: string, title: string, openTasks: number, newestActivity: string | null) => ({ slug, title, openTasks, newestActivity, state: "focused", personal: false });
const task = (id: string, title: string, stage: string, stageReason: string) => ({ id, title, stage, stageReason, slug: "orbit-relay", status: "open" });
const session = (sessionId: string, title: string, startedAt: string, agentName: string | null = null) => ({ sessionId, title, startedAt, agentName });
const agent = (name: string, stateSource: string) => ({ id: name, name, stateSource });
const question = (msgId: string, text: string, asker: string) => ({ msgId, kind: "question", asker, text, at: NOW - HOUR, ageMs: HOUR, options: null, recommended: null, meta: {} });

type Answers = Partial<Record<"health" | "portfolio" | "tasks" | "queue" | "roster" | "sessions", JsonEnvelope<unknown>>>;

const ok = (data: unknown): JsonEnvelope<unknown> => successEnvelope(data);

/** Synthetic answers for every command Home reads; any one can be swapped for a failure. */
function homeSnapshot(answers: Answers = {}): Snapshot {
  return {
    format: SNAPSHOT_FORMAT,
    createdAt: new Date(NOW).toISOString(),
    calls: {
      [snapshotKey("upstreams.health", {})]: answers.health ?? ok({ checkedAt: new Date(NOW).toISOString(), upstreams: HEALTHY }),
      [snapshotKey("work.portfolio", {})]:
        answers.portfolio ??
        ok({ fetchedAt: "", personalKnown: true, parseErrors: [], initiatives: [initiative("orbit-relay", "Orbit relay", 3, ago(2 * HOUR)), initiative("kiln-tools", "Kiln tools", 4, ago(72 * HOUR))] }),
      [snapshotKey("work.tasks", {})]:
        answers.tasks ?? ok({ fetchedAt: "", evidence: { repos: [], degraded: [] }, tasks: [task("OR-7", "Route beacons", "blocked", "Waits on OR-3"), task("OR-8", "Tune relays", "ready", "No blockers")] }),
      [snapshotKey("agents.queue", {})]: answers.queue ?? ok({ items: [question("m-1", "Ship the relay today?\nMore context", "relay-worker")], hidden: { "notice:exit": 9 }, open: 10, generatedAt: NOW }),
      [snapshotKey("agents.roster", {})]: answers.roster ?? ok({ agents: [agent("relay-worker", "presence"), agent("old-worker", "history")], brokerUptimeMs: HOUR, reconnecting: false, generatedAt: NOW }),
      [snapshotKey("sessions.list", { limit: 200 })]:
        answers.sessions ?? ok({ nextBefore: null, degraded: null, sessions: [session("s-today", "Beacon routing", ago(HOUR), "relay-worker"), session("s-old", "Old session", ago(48 * HOUR))] }),
    },
  };
}

const quiet = (): Answers => ({
  health: ok({ checkedAt: new Date(NOW).toISOString(), upstreams: HEALTHY }),
  portfolio: ok({ fetchedAt: "", personalKnown: true, parseErrors: [], initiatives: [initiative("kiln-tools", "Kiln tools", 0, ago(72 * HOUR))] }),
  tasks: ok({ fetchedAt: "", evidence: { repos: [], degraded: [] }, tasks: [] }),
  queue: ok({ items: [], hidden: {}, open: 0, generatedAt: NOW }),
  sessions: ok({ nextBefore: null, degraded: null, sessions: [] }),
});

/** Renders Home from an embedded snapshot and records every command it calls. */
function renderHome(snapshot: Snapshot): string[] {
  const page = new DOMParser().parseFromString(embedSnapshot("<html><head></head><body></body></html>", snapshot), "text/html");
  const inner = pageDataSource({ doc: page });
  const called: string[] = [];
  const source: DataSource = { subscribe: inner.subscribe.bind(inner), call: (name, args, options) => (called.push(name), inner.call(name, args, options)) };
  window.location.hash = "#/";
  render(
    <RpcProvider source={source}>
      <App />
    </RpcProvider>,
  );
  return called;
}

const countOf = (label: string): string | null | undefined => within(screen.getByTestId(`count-${label}`)).getAllByText(/./).at(-1)?.textContent;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the home page", () => {
  it("shows a loading line per region before the first answer", () => {
    renderHome(homeSnapshot());
    for (const label of ["Loading upstream health", "Loading counts", "Loading needs-you", "Loading activity"]) expect(screen.getByLabelText(label)).toBeTruthy();
  });

  it("shows each upstream with its reachability", async () => {
    renderHome(homeSnapshot());
    expect(await screen.findByText("active-work daemon")).toBeTruthy();
    expect(screen.getByText("~/data/graph.sqlite3: 2.0 KiB on disk, not opened")).toBeTruthy();
    expect(screen.getAllByText("reachable")).toHaveLength(3);
  });

  it("counts open tasks, initiatives, live agents and today's sessions", async () => {
    renderHome(homeSnapshot());
    await screen.findByTestId("count-Open tasks");
    expect(["Open tasks", "Initiatives", "Live agents", "Sessions today"].map(countOf)).toEqual(["7", "2", "1", "1"]);
  });

  it("lists open questions, blocked tasks and nothing that is merely ready", async () => {
    renderHome(homeSnapshot());
    expect(await screen.findByText("Ship the relay today?")).toBeTruthy();
    expect(screen.getByText("question from relay-worker")).toBeTruthy();
    expect(screen.getByText("OR-7 Route beacons")).toBeTruthy();
    expect(screen.queryByText("OR-8 Tune relays")).toBeNull();
  });

  it("opens a blocked task's page from its row", async () => {
    renderHome(homeSnapshot());
    fireEvent.click(await screen.findByText("OR-7 Route beacons"));
    await waitFor(() => expect(window.location.hash).toBe("#/tasks/OR-7"));
  });

  it("sends a queue row to agent-chat's queue rather than answering it", async () => {
    const opened = vi.spyOn(window, "open").mockReturnValue(null);
    renderHome(homeSnapshot());
    fireEvent.click(await screen.findByText("Ship the relay today?"));
    expect(opened).toHaveBeenCalledWith("http://127.0.0.1:7600/ui#queue", "_blank", "noopener");
  });

  it("shows the last day's activity newest first and leaves older records out", async () => {
    renderHome(homeSnapshot());
    await screen.findByTestId("activity-session-s-today");
    expect(screen.getAllByTestId(/^activity-/).map((row) => row.getAttribute("data-testid"))).toEqual(["activity-session-s-today", "activity-initiative-orbit-relay"]);
    expect(screen.getByText("Session started by relay-worker")).toBeTruthy();
  });

  it("issues only reads", async () => {
    const called = renderHome(homeSnapshot());
    await screen.findByText("OR-7 Route beacons");
    expect(new Set(called)).toEqual(new Set(["upstreams.health", "work.portfolio", "work.tasks", "agents.queue", "agents.roster", "sessions.list"]));
  });
});

describe("the home page with nothing to show", () => {
  it("says nothing needs the owner and nothing moved", async () => {
    renderHome(homeSnapshot(quiet()));
    expect(await screen.findByText("Nothing needs you")).toBeTruthy();
    expect(screen.getByText("No open queue items, blocked tasks or unreachable upstreams.")).toBeTruthy();
    expect(screen.getByText("No activity in the last 24 hours.")).toBeTruthy();
  });
});

describe("the home page, degraded", () => {
  it("warns that the queue is unreadable, links to agent-chat and still lists the rest", async () => {
    const opened = vi.spyOn(window, "open").mockReturnValue(null);
    renderHome(homeSnapshot({ queue: errorEnvelope("agent-chat broker not answering on port 7600: connect ECONNREFUSED", 69) }));
    expect(await screen.findByText("The agent-chat queue is unreadable: agent-chat broker not answering on port 7600: connect ECONNREFUSED.")).toBeTruthy();
    expect(screen.getByText("OR-7 Route beacons")).toBeTruthy();
    expect(screen.queryByText("Nothing needs you")).toBeNull();
    fireEvent.click(screen.getByRole("link", { name: /Open agent-chat/ }));
    expect(opened).toHaveBeenCalledWith("http://127.0.0.1:7600/ui#queue", "_blank", "noopener");
  });

  it("leaves an unreachable upstream's counts blank and lists it as needing the owner", async () => {
    const health = ok({ checkedAt: "", upstreams: [HEALTHY[0], upstream("agents", "agent-chat broker", "http://127.0.0.1:7600", false, "No answer from /health"), HEALTHY[2]] });
    renderHome(homeSnapshot({ health, roster: errorEnvelope("agent-chat broker not answering on port 7600: refused", 69) }));
    expect(await screen.findByText("agent-chat broker is not answering (No answer from /health). Counts from it are missing.")).toBeTruthy();
    expect(countOf("Live agents")).toBe("–");
    expect(countOf("Open tasks")).toBe("7");
    expect(screen.getByText("agent-chat broker is not answering")).toBeTruthy();
  });

  it("says so when the health command fails", async () => {
    renderHome(homeSnapshot({ health: errorEnvelope("daemon down", 69) }));
    expect(await screen.findByText("Could not load upstream health: daemon down")).toBeTruthy();
  });
});
