import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { silentLogger, type DaemonHandle, type SseMessage } from "@titan-design/daemon";
import { liveSource, type Subscription } from "@titan-design/rpc-client";
import type { ConsoleConfig } from "./config.js";
import { startConsoleDaemon } from "./daemon.js";
import { MAX_FRAME_CHARS, brokerIds, startEventsRelay, type EventsRelay, type RelayTiming, type RelayUpstream } from "./events-relay.js";

const TOKEN = "synthetic-token";

interface FakeStream {
  port: number;
  /** The headers of every `/events` dial, in order, with the time it arrived. */
  dials: Array<{ at: number; headers: IncomingHttpHeaders }>;
  openCount(): number;
  write(text: string): void;
  /** Ends every open stream from the upstream side, as a restart would. */
  drop(): void;
  /** `server.close()` alone: it resolves only once every socket the relay opened has closed. */
  close(): Promise<void>;
}

/** A loopback `/events` that streams whatever the test writes; with `token`, a dial without that header gets 401. */
async function startFakeStream(token?: string): Promise<FakeStream> {
  const dials: FakeStream["dials"] = [];
  const open = new Set<ServerResponse>();
  const server = createServer((req, res) => {
    dials.push({ at: Date.now(), headers: req.headers });
    if (req.url !== "/events" || (token !== undefined && req.headers["x-agent-chat-token"] !== token)) {
      res.writeHead(token !== undefined ? 401 : 404).end();
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.flushHeaders();
    open.add(res);
    res.on("close", () => open.delete(res));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    dials,
    openCount: () => open.size,
    write: (text) => open.forEach((res) => res.write(text)),
    drop: () => open.forEach((res) => res.destroy()),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

async function until(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 100));

const brokerRow = (id: number, kind: string): string =>
  `id: ${id}\nevent: ${kind}\ndata: ${JSON.stringify({ id, ts: 1, kind, actor: "coord", target: "impl", msgId: `m${id}`, ref: "task:X-1", body: "a private body", meta: '{"note":"private meta"}' })}\n\n`;

let dir: string;
let tokenPath: string;
const cleanups: Array<() => Promise<void>> = [];

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "console-relay-"));
  tokenPath = path.join(dir, "ui.token");
  await writeFile(tokenPath, TOKEN);
  await chmod(tokenPath, 0o600);
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  await rm(dir, { recursive: true, force: true });
});

async function fake(token?: string): Promise<FakeStream> {
  const stream = await startFakeStream(token);
  cleanups.push(() => stream.close());
  return stream;
}

function consoleConfig(activeWorkPort: number, agentChatPort: number): ConsoleConfig {
  return {
    port: 0,
    stateDir: path.join(dir, "state"),
    activeWorkPort,
    agentChatPort,
    agentChatTokenPath: tokenPath,
    agentChatEventsDbPath: path.join(dir, "events.db"),
    seatPrefixes: [],
    sessionGraphPath: path.join(dir, "graph.sqlite3"),
    codewatchUrl: "http://codewatch.test:7433",
    lanHost: null,
    lanNames: [],
    lanTls: null,
    lanTokenPath: path.join(dir, "state", "lan.token"),
    ownerWrites: false,
    inboxDir: path.join(dir, "state", "inbox"),
  };
}

describe("the console daemon's /events", () => {
  let handle: DaemonHandle | undefined;
  let browser: Subscription | undefined;

  afterEach(async () => {
    browser?.close();
    await handle?.close();
    handle = undefined;
  });

  it("relays one event per upstream event from active-work and the broker, carrying only kinds and ids", async () => {
    const activeWork = await fake();
    const broker = await fake(TOKEN);
    handle = await startConsoleDaemon({ config: consoleConfig(activeWork.port, broker.port), logger: silentLogger });
    const received: SseMessage[] = [];
    let open = false;
    browser = liveSource({ origin: `http://127.0.0.1:${handle.port}` }).subscribe({
      onEvent: (message) => received.push(message),
      onStatus: (status) => (open ||= status === "open"),
    });
    await until(() => open && activeWork.openCount() === 1 && broker.openCount() === 1);

    activeWork.write("event: ready\ndata: connected\n\nevent: change\ndata: /srv/private/root\n\nevent: ping\ndata: 1\n\nevent: change\ndata: /srv/private/root\n\n");
    await until(() => received.length === 2);
    broker.write(`: heartbeat\n\n${brokerRow(7, "message")}${brokerRow(8, "question")}`);
    await until(() => received.length === 4);
    await settle();

    expect(received.map(({ event, data }) => ({ event, data: JSON.parse(data) as unknown }))).toEqual([
      { event: "active-work", data: { kind: "change" } },
      { event: "active-work", data: { kind: "change" } },
      { event: "agent-chat", data: { kind: "message", id: 7, actor: "coord", target: "impl" } },
      { event: "agent-chat", data: { kind: "question", id: 8, actor: "coord", target: "impl" } },
    ]);
    expect(JSON.stringify(received)).not.toMatch(/private|synthetic-token|task:X-1/);
    expect(broker.dials[0]?.headers["x-agent-chat-token"]).toBe(TOKEN);
    expect(activeWork.dials[0]?.headers["x-agent-chat-token"]).toBeUndefined();
  });
});

describe("the events relay", () => {
  const relays: EventsRelay[] = [];
  afterEach(async () => {
    await Promise.all(relays.splice(0).map((relay) => relay.close()));
  });

  function startRelay(upstream: RelayUpstream, timing: Partial<RelayTiming> = { baseDelayMs: 10, maxDelayMs: 40 }): SseMessage[] {
    const relayed: SseMessage[] = [];
    relays.push(startEventsRelay({ hub: { broadcast: (message) => relayed.push(message) }, upstreams: [upstream], logger: silentLogger, timing }));
    return relayed;
  }

  const brokerAt = (port: number, token = TOKEN): RelayUpstream => ({
    source: "agent-chat",
    url: `http://127.0.0.1:${port}/events`,
    headers: async () => ({ "x-agent-chat-token": token }),
    pick: brokerIds,
  });

  it("redials a dropped upstream and tells the browser once, so its pages refetch what the gap missed", async () => {
    const broker = await fake(TOKEN);
    const relayed = startRelay(brokerAt(broker.port));
    await until(() => broker.openCount() === 1);

    broker.drop();
    await until(() => broker.openCount() === 1 && broker.dials.length === 2);
    broker.write(brokerRow(9, "answer"));
    await until(() => relayed.length === 2);

    expect(relayed.map(({ data }) => JSON.parse(data) as unknown)).toEqual([
      { kind: "reconnected" },
      { kind: "answer", id: 9, actor: "coord", target: "impl" },
    ]);
  });

  /** Drops each of the first `count` streams the moment it opens; returns the gaps between dials. */
  async function flap(broker: FakeStream, count: number): Promise<number[]> {
    for (let dial = 1; dial <= count; dial++) {
      await until(() => broker.dials.length === dial && broker.openCount() === 1);
      broker.drop();
    }
    return broker.dials.slice(1).map((dial, i) => dial.at - broker.dials[i]!.at);
  }

  it("keeps backing off an upstream that drops every stream at once, warning once rather than per drop", async () => {
    const broker = await fake(TOKEN);
    const warnings: string[] = [];
    const logger = { ...silentLogger, warn: (_fields: Record<string, unknown>, message: string) => void warnings.push(message) };
    relays.push(startEventsRelay({ hub: { broadcast: () => undefined }, upstreams: [brokerAt(broker.port)], logger, timing: { baseDelayMs: 20, maxDelayMs: 320 } }));

    const gaps = await flap(broker, 5);

    expect(gaps.map((gap, i) => gap >= 0.9 * Math.min(20 * 2 ** (i + 1), 320))).toEqual([true, true, true, true]);
    expect(warnings).toHaveLength(1);
  });

  it("resets the backoff only after a stream has stayed up for stableMs", async () => {
    const broker = await fake(TOKEN);
    startRelay(brokerAt(broker.port), { baseDelayMs: 20, maxDelayMs: 320, stableMs: 30 });
    await flap(broker, 2);

    await until(() => broker.dials.length === 3 && broker.openCount() === 1);
    await new Promise((resolve) => setTimeout(resolve, 60));
    broker.drop();
    await until(() => broker.dials.length === 4);

    const afterStable = broker.dials[3]!.at - broker.dials[2]!.at - 60;
    expect(afterStable).toBeLessThan(80);
  });

  it("backs off between refused dials, doubling to the cap, and relays nothing", async () => {
    const broker = await fake(TOKEN);
    const relayed = startRelay(brokerAt(broker.port, "wrong-token"), { baseDelayMs: 20, maxDelayMs: 80 });

    await until(() => broker.dials.length >= 5);

    const gaps = broker.dials.slice(1).map((dial, i) => dial.at - broker.dials[i]!.at);
    expect(gaps.every((gap) => gap >= 35)).toBe(true);
    expect(gaps.at(-1)).toBeLessThan(400);
    expect(relayed).toEqual([]);
  });

  it("drops a connection whose unterminated frame passes the cap, then redials", async () => {
    const broker = await fake(TOKEN);
    const relayed = startRelay(brokerAt(broker.port));
    await until(() => broker.openCount() === 1);

    broker.write(`data: ${"x".repeat(MAX_FRAME_CHARS + 1024)}`);
    await until(() => broker.dials.length === 2);

    expect(relayed.map(({ data }) => JSON.parse(data) as unknown)).toEqual([{ kind: "reconnected" }]);
  });

  it("abandons an upstream that goes silent past the idle timeout", async () => {
    const broker = await fake(TOKEN);
    const relayed = startRelay(brokerAt(broker.port), { baseDelayMs: 10, maxDelayMs: 40, idleTimeoutMs: 50 });
    await until(() => broker.openCount() === 1);

    await until(() => broker.dials.length >= 2);

    expect(relayed.map(({ data }) => JSON.parse(data) as unknown)[0]).toEqual({ kind: "reconnected" });
  });

  it("closes every upstream socket on close, so the upstream server can close", async () => {
    const broker = await fake(TOKEN);
    const relay = startEventsRelay({ hub: { broadcast: () => undefined }, upstreams: [brokerAt(broker.port)], logger: silentLogger });
    await until(() => broker.openCount() === 1);

    await relay.close();
    await broker.close();

    await until(() => broker.openCount() === 0, 500);
  });
});

describe("brokerIds", () => {
  it("keeps the row id and the agent names and nothing else", () => {
    expect(brokerIds(JSON.stringify({ id: 3, actor: "a-1", target: "b.2", body: "x", meta: "y", ref: "z" }))).toEqual({ id: 3, actor: "a-1", target: "b.2" });
  });

  it("drops a name with spaces or newlines, a non-integer id, and data that is not an object", () => {
    expect(brokerIds(JSON.stringify({ id: 1.5, actor: "two words", target: "a\nb" }))).toEqual({});
    expect(brokerIds('{"reason":"gap_too_large","latestId":40}')).toEqual({});
    expect(brokerIds("not json")).toEqual({});
    expect(brokerIds("[1]")).toEqual({});
  });
});
