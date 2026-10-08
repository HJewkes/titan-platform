import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT, invokeCommand } from "@titan-design/registry";
import { openSessionGraph, type SessionGraph } from "@titan-design/session-graph";
import { sessionsCommands, type SessionsListResult, type SessionsSource, type SessionTimelineResult } from "./sessions.js";

const FINISHED = "0a1b2c3d-0000-4000-8000-000000000001";
const OLDER = "0a1b2c3d-0000-4000-8000-000000000002";
const GONE = "0a1b2c3d-0000-4000-8000-000000000003";
const LIVE = "0a1b2c3d-0000-4000-8000-000000000004";
const PROJECT = "-work-example";

let dir: string;
let home: string;
let graphPath: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "console-sessions-"));
  home = path.join(dir, "home");
  graphPath = path.join(dir, "graph.sqlite3");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Invented lines in Claude Code's transcript format: one prompt, one reply with a tool call, its result. */
function transcriptLines(sessionId: string): string {
  const line = (fields: Record<string, unknown>) => JSON.stringify({ sessionId, ...fields });
  return [
    line({ type: "user", uuid: "u1", timestamp: "2026-09-01T10:00:00Z", message: { role: "user", content: "list the files" } }),
    line({
      type: "assistant", uuid: "a1", timestamp: "2026-09-01T10:00:05Z",
      message: { role: "assistant", id: "msg-1", model: "claude-opus-5", usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: "tool_use", id: "call-1", name: "Bash", input: { command: "ls" } }] },
    }),
    line({ type: "user", uuid: "u2", timestamp: "2026-09-01T10:00:07Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: "a.txt" }] } }),
  ].join("\n") + "\n";
}

/** A transcript under `<home>/<configDir>/projects/<project>/`; returns its `~`-relative key as the graph stores it. */
async function writeTranscript(sessionId: string, configDir = ".claude"): Promise<string> {
  const projectDir = path.join(home, configDir, "projects", PROJECT);
  await mkdir(projectDir, { recursive: true });
  await writeFile(path.join(projectDir, `${sessionId}.jsonl`), transcriptLines(sessionId));
  return `~/${configDir}/projects/${PROJECT}/${sessionId}.jsonl`;
}

interface IndexedSession {
  sessionId: string;
  startedAt: string;
  sourceKey: string;
  agentName?: string;
  taskIds?: string[];
  missing?: boolean;
}

function indexSession(graph: SessionGraph, session: IndexedSession): void {
  const { sourceId } = graph.transcripts.ensure(session.sourceKey);
  if (session.missing) graph.transcripts.markStatus(session.sourceKey, "missing");
  graph.db
    .prepare("INSERT INTO session (session_id, transcript_id, started_at, ended_at, cwd, ai_title, turn_count) VALUES (?, ?, ?, ?, '/work/example', 'Example', 1)")
    .run(session.sessionId, sourceId, session.startedAt, session.startedAt);
  graph.db
    .prepare("INSERT INTO session_model_usage (session_id, model, input_tokens, output_tokens, request_count) VALUES (?, 'claude-opus-5', 1000000, 0, 2)")
    .run(session.sessionId);
  if (session.agentName === undefined) return;
  graph.db
    .prepare("INSERT INTO session_origin (session_id, origin_system, agent_name, task_ids, resolved_at) VALUES (?, 'agent-chat', ?, ?, '2026-09-01T00:00:00Z')")
    .run(session.sessionId, session.agentName, JSON.stringify(session.taskIds ?? []));
}

/** The graph a finished-session indexer would leave: two indexed sessions with transcripts, one whose transcript is gone. */
async function seedGraph(): Promise<void> {
  const graph = openSessionGraph(graphPath);
  try {
    indexSession(graph, { sessionId: FINISHED, startedAt: "2026-09-01T10:00:00Z", sourceKey: await writeTranscript(FINISHED), agentName: "impl-a", taskIds: ["XY-1"] });
    indexSession(graph, { sessionId: OLDER, startedAt: "2026-08-31T10:00:00Z", sourceKey: await writeTranscript(OLDER, ".claude-profiles/work"), agentName: "impl-b" });
    indexSession(graph, { sessionId: GONE, startedAt: "2026-08-30T10:00:00Z", sourceKey: `~/.claude/projects/${PROJECT}/${GONE}.jsonl`, missing: true });
    graph.edges.assert({ sourceRef: `session:${FINISHED}`, relation: "linked", targetRef: "pr:example/repo#7" });
  } finally {
    graph.db.close();
  }
}

function source(): SessionsSource {
  return {
    graphPath,
    home,
    roots: () => [
      { root: path.join(home, ".claude", "projects"), account: "default" },
      { root: path.join(home, ".claude-profiles", "work", "projects"), account: "work" },
    ],
    now: () => Date.parse("2026-09-02T00:00:00Z"),
  };
}

async function invoke(name: "sessions.list" | "sessions.timeline", args: Record<string, unknown>) {
  const command = sessionsCommands(source())[name];
  return invokeCommand(command, args, { warnings: [], format: "json" });
}

async function list(args: Record<string, unknown> = {}): Promise<SessionsListResult> {
  const { envelope } = await invoke("sessions.list", args);
  expect(envelope.ok).toBe(true);
  return (envelope as { data: SessionsListResult }).data;
}

async function timeline(sessionId: string): Promise<SessionTimelineResult> {
  const { envelope } = await invoke("sessions.timeline", { sessionId });
  expect(envelope.ok).toBe(true);
  return (envelope as { data: SessionTimelineResult }).data;
}

describe("sessions.list", () => {
  it("lists indexed sessions newest first with agent, tasks, linked PRs and priced usage", async () => {
    await seedGraph();

    const result = await list();

    expect(result.degraded).toBeNull();
    expect(result.sessions.map((s) => s.sessionId)).toEqual([FINISHED, OLDER, GONE]);
    expect(result.sessions[0]).toMatchObject({ agentName: "impl-a", taskIds: ["XY-1"], prs: ["pr:example/repo#7"], transcript: { status: "ok" } });
    expect(result.sessions[0]?.usage).toEqual([expect.objectContaining({ model: "claude-opus-5", inputTokens: 1_000_000, requests: 2, priced: true })]);
    expect(result.sessions[0]?.costUsd).toBeGreaterThan(0);
  });

  it("pages with the before cursor", async () => {
    await seedGraph();

    const first = await list({ limit: 2 });
    const second = await list({ limit: 2, before: first.nextBefore });

    expect(first.nextBefore).toBe("2026-08-31T10:00:00Z");
    expect(second.sessions.map((s) => s.sessionId)).toEqual([GONE]);
    expect(second.nextBefore).toBeNull();
  });

  it("keeps only one agent's sessions when asked", async () => {
    await seedGraph();

    const result = await list({ agent: "impl-b" });

    expect(result.sessions.map((s) => s.sessionId)).toEqual([OLDER]);
  });

  it("returns a degraded empty page when the graph file does not exist", async () => {
    const result = await list();

    expect(result).toMatchObject({ sessions: [], nextBefore: null, degraded: { reason: "graph-missing" } });
  });

  it("returns a degraded empty page when the graph lacks a migration the console expects", async () => {
    await seedGraph();
    const graph = openSessionGraph(graphPath);
    graph.db.exec("DELETE FROM _migration WHERE version = (SELECT MAX(version) FROM _migration)");
    graph.db.close();

    const result = await list();

    expect(result).toMatchObject({ sessions: [], degraded: { reason: "graph-not-migrated" } });
  });
});

describe("sessions.timeline", () => {
  it("builds a finished session's timeline from the transcript the graph points at", async () => {
    await seedGraph();

    const result = await timeline(OLDER);

    expect(result).toMatchObject({ status: "ok", source: "graph", session: { sessionId: OLDER, agentName: "impl-b" } });
    if (result.status !== "ok") throw new Error("expected a timeline");
    expect(result.timeline).toMatchObject({ sessionId: OLDER, harness: "claude-code", durationMs: 7_000 });
    expect(result.timeline.turns.flatMap((turn) => turn.toolCalls).map((call) => [call.name, call.outcome])).toEqual([["Bash", "unknown"]]);
  });

  it("returns a degraded entry with the graph's rollups when the indexed transcript is gone", async () => {
    await seedGraph();

    const result = await timeline(GONE);

    expect(result).toMatchObject({ status: "degraded", degraded: { reason: "transcript-missing" }, session: { sessionId: GONE, turnCount: 1 } });
    if (result.status !== "degraded") throw new Error("expected a degraded entry");
    expect(result.session?.usage[0]).toMatchObject({ inputTokens: 1_000_000, requests: 2 });
  });

  it("finds a live session the graph has not indexed yet under a Claude config root", async () => {
    await seedGraph();
    await writeTranscript(LIVE, ".claude-profiles/work");

    const result = await timeline(LIVE);

    expect(result).toMatchObject({ status: "ok", source: "filesystem", session: null, timeline: { sessionId: LIVE } });
  });

  it("still reads a live transcript when the graph file does not exist", async () => {
    await writeTranscript(LIVE);

    const result = await timeline(LIVE);

    expect(result).toMatchObject({ status: "ok", source: "filesystem", timeline: { sessionId: LIVE } });
  });

  it("returns a degraded entry when neither the graph nor any root has the session", async () => {
    const result = await timeline(LIVE);

    expect(result).toMatchObject({ status: "degraded", sessionId: LIVE, degraded: { reason: "graph-missing" }, session: null });
  });

  it("reports not found when the graph is readable and no root has the transcript", async () => {
    await seedGraph();

    const { envelope, exitCode } = await invoke("sessions.timeline", { sessionId: LIVE });

    expect(envelope.ok).toBe(false);
    expect(exitCode).toBe(EXIT.NOINPUT);
  });

  it("refuses an id that is not one filename component", async () => {
    const { envelope } = await invoke("sessions.timeline", { sessionId: "../escape" });

    expect(envelope.ok).toBe(false);
  });
});
