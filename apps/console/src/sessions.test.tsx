// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { RpcProvider, embedSnapshot, pageDataSource } from "@titan-design/react-app";
import { errorEnvelope, successEnvelope } from "@titan-design/registry";
import { SNAPSHOT_FORMAT, snapshotKey, type Snapshot } from "@titan-design/rpc-client";
import type { ConsoleCommands } from "../server/commands.js";
import { App } from "./App.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

type ListResult = ConsoleCommands["sessions.list"]["result"];
type Row = ListResult["sessions"][number];
type TimelineResult = ConsoleCommands["sessions.timeline"]["result"];
type TimelineOk = Extract<TimelineResult, { status: "ok" }>;
type Timeline = TimelineOk["timeline"];
type Turn = Timeline["turns"][number];

const NEWEST = "a1b2c3d4-0000-4000-8000-000000000001";
const OLDER = "a1b2c3d4-0000-4000-8000-000000000002";
const OLDEST = "a1b2c3d4-0000-4000-8000-000000000003";

function row(sessionId: string, startedAt: string, endedAt: string, overrides: Partial<Row> = {}): Row {
  return {
    sessionId, title: "Retry a dropped handshake", startedAt, endedAt, cwd: "/work/orbit", gitBranch: "feat/handshake-retry", turnCount: 2,
    transcript: { path: "~/.claude/projects/orbit/session.jsonl", status: "ok" }, agentName: "orbit-builder", parentSessionId: null,
    taskIds: ["OR-12"], prs: ["pr:example/orbit#41"],
    usage: [{ model: "model-a", inputTokens: 1_000, cacheReadTokens: 200_000, cacheCreationTokens: 40_000, outputTokens: 9_000, requests: 12, costUsd: 3.4, priced: true }],
    costUsd: 3.4, ...overrides,
  };
}

const ZERO_TOKENS = { input: 0, cacheRead: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 0 };

function turn(index: number, prompt: string, reply: string, toolName: string): Turn {
  const base = index * 10;
  return {
    index, origin: "prompt", injectedMarker: null, startMs: Date.UTC(2031, 2, 4, 9, index), endMs: null, gapBeforeMs: null,
    user: { role: "user", seq: base, atMs: null, text: prompt, truncated: false, byteOffset: base },
    assistant: [{ role: "assistant", seq: base + 2, atMs: null, text: reply, truncated: false, byteOffset: base + 2 }],
    toolCalls: [{ id: `call-${index}`, seq: base + 1, turnIndex: index, name: toolName, family: "fs_read", atMs: null, endMs: null, durationMs: 40, outcome: "success", errorMessage: null, inputSummary: "src/handshake.ts", filePath: "src/handshake.ts", sidechain: false, byteOffset: base + 1 }],
    errorCount: 0, tokens: ZERO_TOKENS, costUsd: 0,
  };
}

function timeline(turns: Turn[]): Timeline {
  return {
    version: 1, sessionId: NEWEST, harness: "claude-code", startMs: Date.UTC(2031, 2, 4, 9), endMs: Date.UTC(2031, 2, 4, 10, 5), durationMs: 65 * 60_000,
    totals: { turns: turns.length, userMessages: turns.length, assistantMessages: turns.length, toolCalls: turns.length, errors: 0, compactions: 0, requests: 3, unpricedRequests: 0, tokens: { ...ZERO_TOKENS, input: 500, output: 700 }, costUsd: 0.25 },
    turns, buckets: [], gaps: [], tokens: { basis: "delta", points: [], compactions: [], models: [{ model: "model-b", requests: 3 }] },
    tools: { byName: [], byFamily: [], atMs: [] },
    files: { touches: [{ path: "/work/orbit/src/handshake.ts", access: "read", atMs: null, calls: 2 }, { path: "/work/orbit/src/handshake.ts", access: "write", atMs: null, calls: 1 }, { path: "/scratch/notes.txt", access: "read", atMs: null, calls: 1 }], readCount: 2, writeCount: 1 },
    errors: { rate: 0, items: [], atMs: [] }, agents: [],
  };
}

const TURNS = [turn(0, "Add **backoff** to the handshake retry", "Backoff now doubles up to thirty seconds.", "Read"), turn(1, "Now cover it with a test", "Added a retry test.", "Edit")];

function okTimeline(source: "graph" | "filesystem", turns: Turn[] = TURNS): TimelineOk {
  return {
    status: "ok", sessionId: NEWEST, source, path: "/work/session.jsonl",
    session: source === "graph" ? row(NEWEST, "2031-03-04T09:00:00.000Z", "2031-03-04T10:05:00.000Z") : null,
    timeline: timeline(turns),
    touchedFiles: [
      { touchPath: "/work/orbit/src/handshake.ts", ref: "file:orbit:src/handshake.ts", repo: "orbit", path: "src/handshake.ts", nodeId: "src/handshake.ts", href: "http://127.0.0.1:7700/#/node/src%2Fhandshake.ts" },
      { touchPath: "/scratch/notes.txt", ref: "file:/scratch/notes.txt", repo: null, path: "/scratch/notes.txt", nodeId: null, href: null },
    ],
  };
}

const FIRST_PAGE: ListResult = {
  sessions: [row(NEWEST, "2031-03-04T09:00:00.000Z", "2031-03-04T10:05:00.000Z"), row(OLDER, "2031-03-04T08:00:00.000Z", "2031-03-04T08:00:45.000Z", { agentName: "kiln-reviewer", taskIds: [], prs: [] })],
  nextBefore: "2031-03-04T08:00:00.000Z",
  degraded: null,
};

const OLDER_PAGE: ListResult = { sessions: [row(OLDEST, "2031-03-03T12:00:00.000Z", "2031-03-03T12:20:00.000Z", { taskIds: ["OR-9", "OR-10"] })], nextBefore: null, degraded: null };

function snapshot(calls: Snapshot["calls"]): Snapshot {
  return { format: SNAPSHOT_FORMAT, createdAt: "2031-03-05T00:00:00.000Z", calls };
}

function recorded(overrides: Snapshot["calls"] = {}): Snapshot {
  return snapshot({
    [snapshotKey("sessions.list", { limit: 50 })]: successEnvelope(FIRST_PAGE),
    [snapshotKey("sessions.list", { limit: 50, before: "2031-03-04T08:00:00.000Z" })]: successEnvelope(OLDER_PAGE),
    [snapshotKey("sessions.list", { limit: 50, agent: "kiln-reviewer" })]: successEnvelope({ ...FIRST_PAGE, sessions: FIRST_PAGE.sessions.slice(1), nextBefore: null }),
    [snapshotKey("sessions.timeline", { sessionId: NEWEST })]: successEnvelope(okTimeline("graph")),
    ...overrides,
  });
}

const listWith = (result: ListResult): Snapshot["calls"] => ({ [snapshotKey("sessions.list", { limit: 50 })]: successEnvelope(result) });
const timelineWith = (result: TimelineResult): Snapshot["calls"] => ({ [snapshotKey("sessions.timeline", { sessionId: NEWEST })]: successEnvelope(result) });

function renderConsole(hash: string, data: Snapshot): void {
  const page = new DOMParser().parseFromString(embedSnapshot("<html><head></head><body></body></html>", data), "text/html");
  window.location.hash = hash;
  render(
    <RpcProvider source={pageDataSource({ doc: page })}>
      <App />
    </RpcProvider>,
  );
}

const cells = (testId: string): string[] => within(screen.getByTestId(testId)).getAllByRole("cell").map((cell) => cell.textContent ?? "");

describe("the sessions list", () => {
  it("shows each session's agent, tasks, PR, duration, tokens and cost", async () => {
    renderConsole("#/sessions", recorded());
    await screen.findByTestId(`session-row-${NEWEST}`);
    const [agent, tasks, pr, , duration, tokens, cost] = cells(`session-row-${NEWEST}`);
    expect([agent, tasks, pr, duration, tokens, cost]).toEqual(["orbit-builder", "OR-12", "example/orbit#41 ↗", "1h 05m", "250K", "$3.40"]);
    expect(cells(`session-row-${OLDER}`).slice(4)).toEqual(["45s", "250K", "$3.40"]);
  });

  it("says how fresh the index is", async () => {
    renderConsole("#/sessions", recorded());
    expect((await screen.findByTestId("sessions-indexed")).textContent).toMatch(/^Indexed to .+2031.*\. Newer sessions may be missing\.$/);
  });

  it("loads the older page on the before cursor and stops at the last page", async () => {
    renderConsole("#/sessions", recorded());
    fireEvent.click(await screen.findByText("Load more"));
    expect(await screen.findByTestId(`session-row-${OLDEST}`)).toBeTruthy();
    expect(cells(`session-row-${OLDEST}`)[1]).toBe("OR-9OR-10");
    await waitFor(() => expect(screen.queryByText("Load more")).toBeNull());
  });

  it("filters by the agent in the query string and clears it from the chip", async () => {
    renderConsole("#/sessions?agent=kiln-reviewer", recorded());
    expect(await screen.findByText("agent: kiln-reviewer")).toBeTruthy();
    expect(screen.getAllByTestId(/^session-row-/)).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: /remove|delete|dismiss/i }));
    await waitFor(() => expect(window.location.hash).toBe("#/sessions"));
  });

  it("filters to an agent from its cell", async () => {
    renderConsole("#/sessions", recorded());
    fireEvent.click(within(await screen.findByTestId(`session-row-${OLDER}`)).getByText("kiln-reviewer"));
    await waitFor(() => expect(window.location.hash).toBe("#/sessions?agent=kiln-reviewer"));
    expect(await screen.findByText("agent: kiln-reviewer")).toBeTruthy();
  });

  it("opens a session from its start time", async () => {
    renderConsole("#/sessions", recorded());
    fireEvent.click(await screen.findByTestId(`session-link-${NEWEST}`));
    await waitFor(() => expect(window.location.hash).toBe(`#/sessions/${NEWEST}`));
    expect(await screen.findByText("Conversation (2)")).toBeTruthy();
  });

  it("says so when the graph holds no sessions", async () => {
    renderConsole("#/sessions", recorded(listWith({ sessions: [], nextBefore: null, degraded: null })));
    expect(await screen.findByText("No sessions recorded")).toBeTruthy();
    expect(screen.getByText("The session graph holds no sessions yet.")).toBeTruthy();
  });

  it.each([
    ["graph-missing", "missing"],
    ["graph-not-migrated", "older than this console"],
    ["graph-unreadable", "unreadable"],
  ] as const)("warns by reason when the graph is %s", async (reason, state) => {
    renderConsole("#/sessions", recorded(listWith({ sessions: [], nextBefore: null, degraded: { reason, detail: "No session graph at /data/graph.sqlite3" } })));
    expect(await screen.findByText(`The session list is unavailable: the session graph is ${state}. A session still opens by id from a task or agent page.`)).toBeTruthy();
    expect(screen.getByText("No session graph at /data/graph.sqlite3")).toBeTruthy();
  });

  it("says so when the list cannot be read", async () => {
    renderConsole("#/sessions", snapshot({}));
    expect(await screen.findByText(/^Could not load sessions: /)).toBeTruthy();
  });
});

describe("a session's detail", () => {
  it("shows a header of facts from the session graph", async () => {
    renderConsole(`#/sessions/${NEWEST}`, recorded());
    expect(await screen.findByText("Retry a dropped handshake")).toBeTruthy();
    for (const text of ["orbit-builder", "OR-12", "1h 05m", "model-a", "250K", "$3.40", "feat/handshake-retry", "example/orbit#41 ↗"]) expect(screen.getByText(text)).toBeTruthy();
  });

  it("opens the first turn of the conversation and keeps the rest collapsed", async () => {
    renderConsole(`#/sessions/${NEWEST}`, recorded());
    expect(await screen.findByText("Backoff now doubles up to thirty seconds.")).toBeTruthy();
    expect(screen.getByText("Read")).toBeTruthy();
    expect(screen.queryByText("Added a retry test.")).toBeNull();
    fireEvent.click(screen.getByText("Turn 2"));
    expect(await screen.findByText("Added a retry test.")).toBeTruthy();
  });

  it("opens the turn a deep link names", async () => {
    renderConsole(`#/sessions/${NEWEST}?turn=1`, recorded());
    expect(await screen.findByText("Added a retry test.")).toBeTruthy();
    expect(screen.queryByText("Backoff now doubles up to thirty seconds.")).toBeNull();
  });

  it("links a touched file to its codewatch node and leaves an unmapped one as text", async () => {
    const opened = vi.spyOn(window, "open").mockReturnValue(null);
    renderConsole(`#/sessions/${NEWEST}`, recorded());
    fireEvent.click(await screen.findByText("Files (2)"));
    fireEvent.click(within(await screen.findByTestId("touched-src/handshake.ts")).getByRole("link"));
    expect(opened).toHaveBeenCalledWith("http://127.0.0.1:7700/#/node/src%2Fhandshake.ts", "_blank", "noopener");
    expect(cells("touched-src/handshake.ts")).toEqual(["src/handshake.ts ↗", "readwrite", "3"]);
    expect(within(screen.getByTestId("touched-/scratch/notes.txt")).queryByRole("link")).toBeNull();
    expect(cells("touched-/scratch/notes.txt")).toEqual(["/scratch/notes.txt", "read", "1"]);
  });

  it("says so for a session with no turns", async () => {
    renderConsole(`#/sessions/${NEWEST}`, recorded(timelineWith(okTimeline("graph", []))));
    expect(await screen.findByText("No turns")).toBeTruthy();
    expect(screen.getByText("This session has no messages or tool calls yet.")).toBeTruthy();
  });

  it("notes a session read from disk before the graph indexed it", async () => {
    renderConsole(`#/sessions/${NEWEST}`, recorded(timelineWith(okTimeline("filesystem"))));
    expect(await screen.findByText(/^This session is not in the session graph yet/)).toBeTruthy();
    expect(screen.getByText("model-b")).toBeTruthy();
  });

  it("keeps the graph's header when the transcript is gone", async () => {
    const session = row(NEWEST, "2031-03-04T09:00:00.000Z", "2031-03-04T10:05:00.000Z");
    renderConsole(`#/sessions/${NEWEST}`, recorded(timelineWith({ status: "degraded", sessionId: NEWEST, session, degraded: { reason: "transcript-missing", detail: "gone" } })));
    expect(await screen.findByText(/^This session's transcript is gone\./)).toBeTruthy();
    expect(screen.getByText("orbit-builder")).toBeTruthy();
    expect(screen.queryByText(/^Conversation/)).toBeNull();
  });

  it("warns when the graph is unreadable and no transcript is on disk", async () => {
    renderConsole(`#/sessions/${NEWEST}`, recorded(timelineWith({ status: "degraded", sessionId: NEWEST, session: null, degraded: { reason: "graph-not-migrated", detail: "Run the migration." } })));
    expect(await screen.findByText("The session graph is older than this console, and no transcript for this session is on disk. Run the migration.")).toBeTruthy();
  });

  it("says so for a session in neither the graph nor on disk", async () => {
    renderConsole(`#/sessions/${OLDEST}`, recorded({ [snapshotKey("sessions.timeline", { sessionId: OLDEST })]: errorEnvelope(`No session ${OLDEST}`, 66) }));
    expect(await screen.findByText(`No session ${OLDEST} in the session graph or on disk.`)).toBeTruthy();
  });

  it("says so when the timeline cannot be read", async () => {
    renderConsole(`#/sessions/${OLDEST}`, recorded({ [snapshotKey("sessions.timeline", { sessionId: OLDEST })]: errorEnvelope("transcript is not JSON lines", 65) }));
    expect(await screen.findByText(`Could not load session ${OLDEST}: transcript is not JSON lines`)).toBeTruthy();
  });

  it("returns to the list from the breadcrumb", async () => {
    renderConsole(`#/sessions/${NEWEST}`, recorded());
    fireEvent.click(await screen.findByRole("link", { name: "Sessions" }));
    await waitFor(() => expect(window.location.hash).toBe("#/sessions"));
  });
});
