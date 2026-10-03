import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT, createRegistry, invokeCommand, type BaseContext } from "@titan-design/registry";
import { agentsCommands } from "./agents.js";
import { brokerReader } from "./broker.js";
import { closedPort, startFakeBroker, type FakeDaemon } from "./test-support.js";

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

let dir: string;
let broker: FakeDaemon | undefined;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "console-agents-"));
});

afterEach(async () => {
  await broker?.close();
  broker = undefined;
  await rm(dir, { recursive: true, force: true });
});

async function invoke(name: "agents.roster" | "agents.graph", port: number, tokenPath = path.join(dir, "ui.token")) {
  const commands = agentsCommands({
    broker: brokerReader({ port, tokenPath }),
    seatPrefixes: [{ seat: "coord-seat", prefix: "coord" }],
    now: () => 10_000,
  });
  const registry = createRegistry<BaseContext>();
  for (const command of Object.values(commands)) registry.register(command);
  return invokeCommand(registry.get(name)!, {}, { warnings: [], format: "json" });
}

async function liveBroker(): Promise<number> {
  await writeFile(path.join(dir, "ui.token"), `${TOKEN}\n`);
  broker = await startFakeBroker({ token: TOKEN, sessions: SESSIONS, items: ITEMS });
  return broker.port;
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
    await writeFile(path.join(dir, "ui.token"), TOKEN);
    const { envelope, exitCode } = await invoke("agents.roster", await closedPort());
    expect(envelope.ok).toBe(false);
    expect(exitCode).toBe(EXIT.UNAVAILABLE);
  });

  it("refuses to call the broker without a token file", async () => {
    broker = await startFakeBroker({ token: TOKEN, sessions: [], items: [] });
    const { envelope } = await invoke("agents.roster", broker.port, path.join(dir, "missing.token"));
    expect(envelope).toMatchObject({ ok: false, error: expect.stringMatching(/ui token not readable/) });
  });

  it("surfaces a rejected token as unavailable rather than an empty roster", async () => {
    await writeFile(path.join(dir, "ui.token"), "wrong");
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
