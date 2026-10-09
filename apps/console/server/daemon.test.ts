import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { silentLogger, type DaemonHandle } from "@titan-design/daemon";
import { createRpcClient, liveSource, snapshotKey } from "@titan-design/rpc-client";
import { openSessionGraph } from "@titan-design/session-graph";
import type { ConsoleCommands } from "./commands.js";
import type { ConsoleConfig } from "./config.js";
import { startConsoleDaemon } from "./daemon.js";
import { fixtureAnswer } from "./fixtures.js";
import { createConsoleRegistry, recordFirstPaint } from "./registry.js";
import { closedPort, startFakeBroker, startFakeDaemon, type FakeDaemon } from "./test-support.js";
import { createSources } from "./upstreams.js";

let dir: string;
let activeWork: FakeDaemon;
let config: ConsoleConfig;
let handle: DaemonHandle | undefined;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "console-daemon-"));
  activeWork = await startFakeDaemon({ ok: true, version: "9.9.9", index: {} }, fixtureAnswer);
  config = {
    port: 0,
    stateDir: path.join(dir, "state"),
    activeWorkPort: activeWork.port,
    agentChatPort: await closedPort(),
    agentChatTokenPath: path.join(dir, "ui.token"),
    agentChatEventsDbPath: path.join(dir, "events.db"),
    seatPrefixes: [],
    sessionGraphPath: path.join(dir, "graph.sqlite3"),
    codewatchUrl: "http://codewatch.test:7433",
  };
  await writeFile(config.sessionGraphPath, "synthetic");
});

afterEach(async () => {
  await handle?.close();
  handle = undefined;
  await activeWork.close();
  await rm(dir, { recursive: true, force: true });
});

const origin = (): string => `http://127.0.0.1:${handle!.port}`;

const SESSION = "0a1b2c3d-0000-4000-8000-0000000000aa";

/** An indexed session whose transcript edits each path once, beside a clone of `widget` at `<dir>/checkout`. */
async function seedSessionTouching(files: readonly string[]): Promise<readonly string[]> {
  await mkdir(path.join(dir, "checkout", ".git"), { recursive: true });
  await writeFile(path.join(dir, "checkout", ".git", "config"), '[remote "origin"]\n\turl = https://example.com/acme/widget.git\n');
  const transcript = path.join(dir, `${SESSION}.jsonl`);
  const calls = files.map((file, i) => ({ type: "tool_use", id: `edit-${i}`, name: "Edit", input: { file_path: file } }));
  const reply = { type: "assistant", uuid: "a1", sessionId: SESSION, timestamp: "2026-09-01T10:00:05Z", message: { role: "assistant", id: "m1", model: "claude-opus-5", content: calls } };
  await writeFile(transcript, `${JSON.stringify(reply)}\n`);
  await rm(config.sessionGraphPath);
  const graph = openSessionGraph(config.sessionGraphPath);
  try {
    const { sourceId } = graph.transcripts.ensure(transcript);
    graph.db.prepare("INSERT INTO session (session_id, transcript_id, started_at, turn_count) VALUES (?, ?, '2026-09-01T10:00:00Z', 1)").run(SESSION, sourceId);
  } finally {
    graph.db.close();
  }
  return files;
}

describe("the console daemon", () => {
  it("answers upstreams.health through a typed client with all three upstreams", async () => {
    handle = await startConsoleDaemon({ config, logger: silentLogger });
    const client = createRpcClient<ConsoleCommands>(liveSource({ origin: origin() }));
    const { upstreams, checkedAt } = await client.call("upstreams.health");
    expect(Number.isNaN(Date.parse(checkedAt))).toBe(false);
    expect(upstreams.map(({ id, reachable }) => ({ id, reachable }))).toEqual([
      { id: "work", reachable: true },
      { id: "agents", reachable: false },
      { id: "sessions", reachable: true },
    ]);
  });

  it("answers work.portfolio from the active-work daemon it fronts", async () => {
    handle = await startConsoleDaemon({ config, logger: silentLogger });
    const client = createRpcClient<ConsoleCommands>(liveSource({ origin: origin() }));
    const { initiatives } = await client.call("work.portfolio");
    expect(initiatives).toHaveLength(5);
    const detail = await client.call("work.initiative", { slug: "lantern-docs" });
    expect(detail.tasks.map((task) => task.id)).toEqual(["LD-3"]);
  });

  it("lists the upstream targets on /health without probing them", async () => {
    handle = await startConsoleDaemon({ config, logger: silentLogger });
    const health = (await (await fetch(`${origin()}/health`)).json()) as { ok: boolean; upstreams: Array<{ id: string; target: string }> };
    expect(health.ok).toBe(true);
    expect(health.upstreams.map((u) => u.id)).toEqual(["work", "agents", "sessions"]);
    expect(health.upstreams[0]?.target).toBe(`http://127.0.0.1:${activeWork.port}`);
  });

  it("serves the built app shell at / and for a client route", async () => {
    const page = path.join(dir, "index.html");
    await writeFile(page, "<!doctype html><title>console shell</title>");
    handle = await startConsoleDaemon({ config, staticRoot: page, logger: silentLogger });
    for (const route of ["/", "/sessions"]) {
      const res = await fetch(`${origin()}${route}`);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("console shell");
    }
  });

  it("answers agents.messages and agents.queue from a fake broker over /rpc", async () => {
    const queue = [{ msgId: "q1", kind: "question", from: "coord", text: "Ship?", at: 1_000, meta: {} }];
    const items = [{ msgId: "m1", kind: "message", from: "coord", text: "go", at: 2_000, meta: { target: "impl" } }];
    const broker = await startFakeBroker({ token: "synthetic-token", sessions: [], items, queue });
    await writeFile(config.agentChatTokenPath, "synthetic-token");
    await chmod(config.agentChatTokenPath, 0o600);
    handle = await startConsoleDaemon({ config: { ...config, agentChatPort: broker.port }, logger: silentLogger });
    const client = createRpcClient<ConsoleCommands>(liveSource({ origin: origin() }));
    const messages = await client.call("agents.messages", { agent: "impl", limit: 50 });
    const open = await client.call("agents.queue", {});
    await broker.close();
    expect(messages).toMatchObject({ source: "history", partial: true, messages: [{ msgId: "m1", from: "coord", to: "impl" }] });
    expect(open.items).toMatchObject([{ msgId: "q1", asker: "coord" }]);
    expect(broker.requests.every((request) => request.startsWith("GET "))).toBe(true);
  });

  it("links a session's touched files to codewatch node pages over /rpc", async () => {
    const touched = await seedSessionTouching([path.join(dir, "checkout", ".worktrees", "gone", "src", "a.ts"), path.join(dir, "notes.md")]);
    handle = await startConsoleDaemon({ config, logger: silentLogger });
    const client = createRpcClient<ConsoleCommands>(liveSource({ origin: origin() }));
    const result = await client.call("sessions.timeline", { sessionId: SESSION });
    expect(result).toMatchObject({ status: "ok", source: "graph" });
    expect(result.status === "ok" ? result.touchedFiles : []).toEqual([
      { touchPath: touched[0], ref: "file:widget/src/a.ts", repo: "widget", path: "src/a.ts", nodeId: "src/a.ts", href: "http://codewatch.test:7433#/node/src%2Fa.ts" },
      { touchPath: touched[1], ref: `file:${touched[1]}`, repo: null, path: touched[1], nodeId: null, href: null },
    ]);
  });

  it("refuses a second console over the same state directory", async () => {
    handle = await startConsoleDaemon({ config, logger: silentLogger });
    await expect(startConsoleDaemon({ config, logger: silentLogger })).rejects.toThrow(/already running/);
  });
});

describe("the first-paint snapshot", () => {
  it("records upstreams.health so an exported page needs no daemon", async () => {
    const snapshot = await recordFirstPaint(createConsoleRegistry(createSources(config)));
    expect(snapshot.calls[snapshotKey("upstreams.health", {})]).toMatchObject({ ok: true });
  });
});
