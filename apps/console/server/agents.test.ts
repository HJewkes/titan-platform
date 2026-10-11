import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT, createRegistry, invokeCommand, type BaseContext } from "@titan-design/registry";
import { EVENTS_TABLE_DDL } from "@titan-design/session-analytics";
import { openDatabase } from "@titan-design/store-sqlite";
import { agentsCommands } from "./agents.js";
import { brokerReader } from "./broker.js";
import { closedPort, startFakeBroker, type FakeBroker } from "./test-support.js";

const TOKEN = "synthetic-token";

const SESSIONS = [
  { name: "coord", workingOn: "XY-1: steer", cwd: "/work/a", status: "working", idleMs: 500, registeredAt: 1_000, observed: { claudeSessionId: "sess-coord" } },
  { name: "coord-impl", workingOn: "XY-2: build", cwd: "/work/b", status: "blocked", idleMs: 9_000, registeredAt: 2_000, dnd: true },
];

const ITEMS = [
  { msgId: "agent-impl", kind: "agent_spawned", from: "coord", text: "Build it", at: 2_000, meta: { target: "coord-impl", surface: "headless", profile: "implementer" } },
  { msgId: "agent-old", kind: "agent_spawned", from: "coord", text: "Old work", at: 2_100, meta: { target: "coord-old", session_id: "sess-old" } },
  { msgId: "x1", kind: "agent_exited", from: "coord-old", text: "", at: 2_500, meta: { cost_usd: "0.75" } },
  { msgId: "m1", kind: "message", from: "coord", text: "go", at: 3_000, meta: { target: "coord-impl" } },
  { msgId: "m2", kind: "message", from: "coord", text: "faster", at: 3_500, meta: { target: "coord-impl" } },
];

const QUEUE = [
  { msgId: "n1", kind: "notice", from: "agent-chat", text: "budget", at: 1_000, meta: {} },
  { msgId: "e1", kind: "message", from: "agent-chat", text: "exited", at: 1_500, meta: { event: "unreported-exit", agent: "coord-old" } },
  { msgId: "e2", kind: "message", from: "agent-chat", text: "exited", at: 1_600, meta: { event: "unreported-exit", agent: "coord-impl" } },
  { msgId: "m9", kind: "message", from: "coord", text: "fyi", at: 4_000, meta: {} },
  { msgId: "q2", kind: "question", from: "coord-impl", text: "Which?", at: 6_000, meta: { options: '["a","b"]', recommended: "a" } },
  { msgId: "q1", kind: "question", from: "coord", text: "Ship?", at: 5_000, meta: { options: "not json" } },
];

let dir: string;
let broker: FakeBroker | undefined;
let cleanups: Array<() => Promise<void>> = [];

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "console-agents-"));
});

afterEach(async () => {
  await broker?.close();
  broker = undefined;
  await Promise.all(cleanups.map((cleanup) => cleanup()));
  cleanups = [];
  await rm(dir, { recursive: true, force: true });
});

type AgentsCommand = "agents.roster" | "agents.graph" | "agents.messages" | "agents.queue";

async function invoke(name: AgentsCommand, port: number, tokenPath = path.join(dir, "ui.token"), doFetch?: typeof fetch, args: Record<string, unknown> = {}) {
  const commands = agentsCommands({
    broker: brokerReader({ port, tokenPath, fetch: doFetch }),
    eventsDbPath: path.join(dir, "events.db"),
    seatPrefixes: [{ seat: "coord-seat", prefix: "coord" }],
    now: () => 10_000,
  });
  const registry = createRegistry<BaseContext>();
  for (const command of Object.values(commands)) registry.register(command);
  return invokeCommand(registry.get(name)!, args, { warnings: [], format: "json" });
}

interface EventSeed {
  kind: string;
  actor: string;
  target?: string;
  body?: string;
  meta?: string;
}

/** A synthetic events.db with agent-chat's table; row ids run 1..n in seed order and ts is id * 1000. */
function seedEventsDb(events: readonly EventSeed[]): void {
  const db = openDatabase(path.join(dir, "events.db"));
  db.exec(EVENTS_TABLE_DDL);
  const insert = db.prepare("INSERT INTO events (ts, kind, actor, target, msg_id, ref, body, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  events.forEach((e, i) => insert.run((i + 1) * 1000, e.kind, e.actor, e.target ?? null, `msg-${i + 1}`, null, e.body ?? "", e.meta ?? null));
  db.close();
}

const CONVERSATION: EventSeed[] = [
  { kind: "message", actor: "coord", target: "coord-impl", body: "go" },
  { kind: "agent_spawned", actor: "coord", target: "coord-impl", body: "brief" },
  { kind: "message", actor: "coord-impl", target: "coord", body: "on it" },
  { kind: "message", actor: "coord", target: "other", body: "elsewhere" },
  { kind: "question", actor: "coord-impl", target: "human", body: "Which?", meta: '{"options":"[\\"a\\"]","depth":3}' },
  { kind: "message", actor: "coord", target: "coord-impl", body: "done?" },
];

type Data<T> = { data: T };
const dataOf = <T>(envelope: unknown): T => (envelope as Data<T>).data;

async function writeToken(token: string, mode = 0o600): Promise<void> {
  const file = path.join(dir, "ui.token");
  await writeFile(file, token);
  // chmod rather than writeFile's mode, which the umask would narrow.
  await chmod(file, mode);
}

async function liveBroker(sessions: unknown[] = SESSIONS): Promise<number> {
  await writeToken(`${TOKEN}\n`);
  broker = await startFakeBroker({ token: TOKEN, sessions, items: ITEMS, queue: QUEUE });
  return broker.port;
}

/** A loopback server that redirects every request to the same path on `targetPort`. */
async function redirectingServer(targetPort: number): Promise<number> {
  const server = createServer((req, res) => {
    res.writeHead(307, { location: `http://127.0.0.1:${targetPort}${req.url ?? "/"}` });
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => {
    server.closeAllConnections();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return (server.address() as AddressInfo).port;
}

describe("agents.roster", () => {
  it("lists live sessions with spawn facts, then history-only agents with their exit cost", async () => {
    const { envelope } = await invoke("agents.roster", await liveBroker());
    expect(envelope.ok).toBe(true);
    const agents = (envelope as { data: { agents: Array<Record<string, unknown>> } }).data.agents;
    expect(agents.map((a) => [a.name, a.state, a.stateSource])).toEqual([
      ["coord", "working", "presence"],
      ["coord-impl", "blocked", "presence"],
      ["coord-old", "exited", "history"],
    ]);
    expect(agents[1]).toMatchObject({ id: "coord-impl@2000", spawnedBy: "coord", surface: "headless", seat: "coord-seat", taskId: "XY-2", dnd: true });
    expect(agents[2]).toMatchObject({ id: "sess-old", costUsd: 0.75, costSource: "exit-report" });
  });

  it("reports the broker as unavailable when nothing listens", async () => {
    await writeToken(TOKEN);
    const { envelope, exitCode } = await invoke("agents.roster", await closedPort());
    expect(envelope.ok).toBe(false);
    expect(exitCode).toBe(EXIT.UNAVAILABLE);
  });

  it("refuses to call the broker without a token file", async () => {
    broker = await startFakeBroker({ token: TOKEN, sessions: [], items: [] });
    const { envelope } = await invoke("agents.roster", broker.port, path.join(dir, "missing.token"));
    expect(envelope).toMatchObject({ ok: false, error: expect.stringMatching(/ui token not readable/) });
  });

  it("refuses a token file that group or others can read, before calling the broker", async () => {
    await writeToken(TOKEN, 0o644);
    broker = await startFakeBroker({ token: TOKEN, sessions: SESSIONS, items: ITEMS });
    const { envelope, exitCode } = await invoke("agents.roster", broker.port);
    expect(exitCode).toBe(EXIT.CONFIG);
    expect(envelope).toMatchObject({ ok: false, error: expect.stringMatching(/mode 644; refusing it until it is 600/) });
  });

  it("does not follow a redirect, so the token never reaches another origin", async () => {
    const port = await liveBroker();
    const { envelope, exitCode } = await invoke("agents.roster", await redirectingServer(port));
    expect(envelope.ok).toBe(false);
    expect(exitCode).toBe(EXIT.UNAVAILABLE);
  });

  it("classifies a drifted broker body as an unexpected shape", async () => {
    const { envelope, exitCode } = await invoke("agents.roster", await liveBroker([{ name: 7 }]));
    expect(exitCode).toBe(EXIT.SOFTWARE);
    expect(envelope).toMatchObject({ ok: false, error: "agent-chat broker /api/sessions answered an unexpected shape" });
  });

  it("classifies a non-JSON broker body as an unexpected shape", async () => {
    await writeToken(TOKEN);
    const notJson: typeof fetch = async () => new Response("<html>", { status: 200 });
    const { envelope, exitCode } = await invoke("agents.roster", 1, undefined, notJson);
    expect(exitCode).toBe(EXIT.SOFTWARE);
    expect(envelope).toMatchObject({ ok: false, error: expect.stringMatching(/answered an unexpected shape$/) });
  });

  it("surfaces a rejected token as unavailable rather than an empty roster", async () => {
    await writeToken("wrong");
    broker = await startFakeBroker({ token: TOKEN, sessions: SESSIONS, items: ITEMS });
    const { envelope } = await invoke("agents.roster", broker.port);
    expect(envelope).toMatchObject({ ok: false, error: expect.stringMatching(/answered 401/) });
  });
});

describe("agents.graph", () => {
  it("returns the spawn tree with counted message edges keyed by roster ids", async () => {
    const { envelope } = await invoke("agents.graph", await liveBroker());
    const data = (envelope as { data: { nodes: Array<{ id: string; name: string }>; edges: unknown[] } }).data;
    expect(data.nodes.map((n) => [n.name, n.id])).toEqual([
      ["coord", "sess-coord"],
      ["coord-impl", "coord-impl@2000"],
      ["coord-old", "sess-old"],
    ]);
    expect(data.edges).toContainEqual({ kind: "message", from: "sess-coord", to: "coord-impl@2000", count: 2, lastAt: 3_500 });
    expect(data.edges).toContainEqual({ kind: "spawned", from: "sess-coord", to: "sess-old", count: 1, lastAt: 2_100 });
  });
});

interface Messages {
  messages: Array<{ id: number | null; msgId: string; kind: string; from: string; to: string | null; text: string; meta: Record<string, string> }>;
  source: string;
  partial: boolean;
  nextCursor: number | null;
  history: { events: number; limit: number; oldestAt: number | null } | null;
}

describe("agents.messages", () => {
  it("pages an agent's conversation from events.db, newest first, without lifecycle rows", async () => {
    seedEventsDb(CONVERSATION);
    const { envelope } = await invoke("agents.messages", await closedPort(), undefined, undefined, { agent: "coord-impl" });
    const data = dataOf<Messages>(envelope);
    expect(data).toMatchObject({ source: "events-db", partial: false, nextCursor: null, history: null });
    expect(data.messages.map((m) => [m.id, m.from, m.to, m.text])).toEqual([
      [6, "coord", "coord-impl", "done?"],
      [5, "coord-impl", "human", "Which?"],
      [3, "coord-impl", "coord", "on it"],
      [1, "coord", "coord-impl", "go"],
    ]);
    expect(data.messages[1]!.meta).toEqual({ options: '["a"]' });
  });

  it("narrows to a pair and walks older pages through the id cursor", async () => {
    seedEventsDb(CONVERSATION);
    const port = await closedPort();
    const first = dataOf<Messages>((await invoke("agents.messages", port, undefined, undefined, { agent: "coord", peer: "coord-impl", limit: 2 })).envelope);
    expect(first.messages.map((m) => m.id)).toEqual([6, 3]);
    expect(first.nextCursor).toBe(3);
    const second = dataOf<Messages>((await invoke("agents.messages", port, undefined, undefined, { agent: "coord", peer: "coord-impl", limit: 2, before: 3 })).envelope);
    expect(second.messages.map((m) => m.id)).toEqual([1]);
    expect(second.nextCursor).toBeNull();
  });

  it("lists every agent's messages without an agent, still without lifecycle rows", async () => {
    seedEventsDb(CONVERSATION);
    const data = dataOf<Messages>((await invoke("agents.messages", await closedPort(), undefined, undefined, {})).envelope);
    expect(data.messages.map((m) => m.id)).toEqual([6, 5, 4, 3, 1]);
  });

  it("lists every agent's messages from the history fallback without an agent", async () => {
    const data = dataOf<Messages>((await invoke("agents.messages", await liveBroker(), undefined, undefined, {})).envelope);
    expect(data.messages.map((m) => m.msgId)).toEqual(["m2", "m1"]);
  });

  it("refuses a peer without an agent", async () => {
    const { envelope, exitCode } = await invoke("agents.messages", await closedPort(), undefined, undefined, { peer: "coord" });
    expect(envelope.ok).toBe(false);
    expect(exitCode).toBe(EXIT.DATAERR);
  });

  it("leaves events.db byte for byte unchanged and never calls the broker while it answers", async () => {
    seedEventsDb(CONVERSATION);
    const before = await readFile(path.join(dir, "events.db"));
    const port = await liveBroker();
    const { envelope } = await invoke("agents.messages", port, undefined, undefined, { agent: "coord" });
    expect(envelope.ok).toBe(true);
    expect(await readFile(path.join(dir, "events.db"))).toEqual(before);
    expect(broker!.requests).toEqual([]);
  });

  it("falls back to the broker's history window, flagged partial, when events.db is absent", async () => {
    const port = await liveBroker();
    const data = dataOf<Messages>((await invoke("agents.messages", port, undefined, undefined, { agent: "coord-impl" })).envelope);
    expect(data).toMatchObject({ source: "history", partial: true, nextCursor: null, history: { events: ITEMS.length, limit: 1000, oldestAt: 2_000 } });
    expect(data.messages.map((m) => [m.id, m.msgId, m.to])).toEqual([
      [null, "m2", "coord-impl"],
      [null, "m1", "coord-impl"],
    ]);
    expect(broker!.requests).toEqual(["GET /api/history?limit=1000"]);
  });

  it("returns no fallback page for a cursor, since history has no ids to place it", async () => {
    const data = dataOf<Messages>((await invoke("agents.messages", await liveBroker(), undefined, undefined, { agent: "coord-impl", before: 5 })).envelope);
    expect(data).toMatchObject({ source: "history", partial: true, messages: [] });
  });

  it("is unavailable when events.db is absent and the ui token is too", async () => {
    broker = await startFakeBroker({ token: TOKEN, sessions: [], items: ITEMS });
    const { envelope, exitCode } = await invoke("agents.messages", broker.port, path.join(dir, "missing.token"), undefined, { agent: "coord" });
    expect(exitCode).toBe(EXIT.UNAVAILABLE);
    expect(envelope).toMatchObject({ ok: false, error: expect.stringMatching(/ui token not readable/) });
    expect(broker.requests).toEqual([]);
  });

  it("is unavailable when agent-chat's events table has drifted from the columns it reads", async () => {
    const db = openDatabase(path.join(dir, "events.db"));
    db.exec("CREATE TABLE events (id INTEGER PRIMARY KEY, ts INTEGER, kind TEXT, actor TEXT)");
    db.close();
    const { envelope, exitCode } = await invoke("agents.messages", await closedPort(), undefined, undefined, { agent: "coord" });
    expect(exitCode).toBe(EXIT.UNAVAILABLE);
    expect(envelope).toMatchObject({ ok: false, error: expect.stringMatching(/no events column target, msg_id, ref, body, meta$/) });
  });
});

interface Queue {
  items: Array<{ msgId: string; asker: string; ageMs: number; options: string[] | null; recommended: string | null }>;
  hidden: Record<string, number>;
  open: number;
}

describe("agents.queue", () => {
  it("lists questions first with asker and age, and counts the broker's own notices instead of listing them", async () => {
    const data = dataOf<Queue>((await invoke("agents.queue", await liveBroker())).envelope);
    expect(data.items.map((i) => [i.msgId, i.asker, i.ageMs])).toEqual([
      ["q1", "coord", 5_000],
      ["q2", "coord-impl", 4_000],
      ["m9", "coord", 6_000],
    ]);
    expect(data.items[1]).toMatchObject({ options: ["a", "b"], recommended: "a" });
    expect(data.items[0]).toMatchObject({ options: null, recommended: null });
    expect(data.hidden).toEqual({ notice: 1, "message:unreported-exit": 2 });
    expect(data.open).toBe(QUEUE.length);
  });

  it("lists the broker's notices too when asked, still questions first, and only ever GETs /api/queue", async () => {
    const data = dataOf<Queue>((await invoke("agents.queue", await liveBroker(), undefined, undefined, { include_system: true })).envelope);
    expect(data.items.map((i) => i.msgId)).toEqual(["q1", "q2", "e1", "e2", "m9", "n1"]);
    expect(data.hidden).toEqual({});
    expect(broker!.requests).toEqual(["GET /api/queue"]);
  });

  it("is unavailable without a ui token, before calling the broker", async () => {
    broker = await startFakeBroker({ token: TOKEN, sessions: [], items: [], queue: QUEUE });
    const { envelope, exitCode } = await invoke("agents.queue", broker.port, path.join(dir, "missing.token"));
    expect(exitCode).toBe(EXIT.UNAVAILABLE);
    expect(envelope).toMatchObject({ ok: false, error: expect.stringMatching(/ui token not readable/) });
    expect(broker.requests).toEqual([]);
  });

  it("is unavailable with an empty ui token", async () => {
    await writeToken("");
    broker = await startFakeBroker({ token: TOKEN, sessions: [], items: [], queue: QUEUE });
    const { exitCode } = await invoke("agents.queue", broker.port);
    expect(exitCode).toBe(EXIT.UNAVAILABLE);
    expect(broker.requests).toEqual([]);
  });
});
