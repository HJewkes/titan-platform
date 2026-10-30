import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BrokerEvent, BrokerSession } from "@titan-design/chat-protocol/agents";
import type { RequestAuth } from "@titan-design/daemon";
import { EXIT, invokeCommand, type JsonEnvelope } from "@titan-design/registry";
import { partialFake } from "@titan-design/test-kit";
import { z } from "zod";
import type { AgentsSource } from "./agents.js";
import type { BrokerReader } from "./broker.js";
import type { ActionOutcome, OwnerActionClient } from "./owner-action.js";
import type { ConsoleContext } from "./owner-guard.js";
import { retireTapCommands, type TapPrepareResult } from "./retire-tap.js";
import { shepherdReader } from "./shepherd.js";
import { startFakeDaemon, type FakeDaemon } from "./test-support.js";

const NAME = "item-42";
const AGENT_ID = "9e3faa6c0011";
const OTHER_ID = "77aa00110022";
const TARGET = { kind: "retire-agent", name: NAME } as const;
const SESSION: RequestAuth = { credential: "session", issuedAt: 1_000, peerLocal: false };

let dir: string;
let factory: FakeDaemon | undefined;
let events: BrokerEvent[];
let sessions: BrokerSession[];
let holderId: string;
let previews: unknown[];
let clock: number;

const spawned = (name: string, msgId: string, at: number): BrokerEvent => ({ msgId, kind: "agent_spawned", from: "coordinator", text: "brief", at, meta: { target: name, profile: "impl" } });
const exited = (name: string, at: number): BrokerEvent => ({ msgId: `x-${name}-${at}`, kind: "agent_exited", from: name, text: "", at, meta: {} });

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "console-retire-tap-"));
  clock = 100_000;
  events = [spawned(NAME, AGENT_ID, 1_000), exited(NAME, 90_000)];
  sessions = [];
  holderId = AGENT_ID;
  previews = [];
});

afterEach(async () => {
  await factory?.close();
  factory = undefined;
  await rm(dir, { recursive: true, force: true });
});

const actionsDir = () => path.join(dir, "owner-actions");
const records = () => readdir(actionsDir()).catch(() => [] as string[]);

function agentsSource(): AgentsSource {
  const broker = partialFake<BrokerReader>({ read: async () => ({ sessions, brokerUptimeMs: 60_000, events }) });
  return { broker, eventsDbPath: path.join(dir, "events.db"), seatPrefixes: [{ seat: "tpc-seat", prefix: "tpc" }], now: () => clock };
}

/** `owner-op.preview` as the factory answers a retire: the roster's holder of the name, exited, on no live run. */
function retirePreview() {
  return {
    kind: "retire-agent",
    authority: { verdict: "allow", ruleId: "RET-OR" },
    agent: { name: NAME, holder: { agentId: holderId, state: "exited", presence: "exited", status: "finished", profile: "impl", cwd: "/work/tree", spawnedBy: "coordinator" }, exited: true, liveRun: null },
  };
}

/** The factory route as the console sees it: it retires the record's op once, and a replay of that record reads back `already`. */
function spyFactory(answer?: ActionOutcome) {
  const posted: { actionId: string; bytes: string }[] = [];
  const client: OwnerActionClient = {
    post: async (actionId) => {
      const bytes = await readFile(path.join(actionsDir(), `${actionId}.json`), "utf8");
      posted.push({ actionId, bytes });
      if (answer !== undefined) return answer;
      return posted.length === 1 ? { status: "retired", name: NAME, caveats: ["the process had already exited"] } : { status: "already", name: NAME };
    },
  };
  return { client, posted };
}

const ownerContext = (auth: RequestAuth | null = SESSION, ownerWrites = true): ConsoleContext => ({ warnings: [], format: "json", surface: "http", auth, ownerWrites });

async function harness(client: OwnerActionClient, enabled = true) {
  factory = await startFakeDaemon({ ok: true }, (command, args) => {
    if (command !== "owner-op.preview") throw new Error(`no fixture for ${command}`);
    previews.push(args.op);
    return retirePreview();
  });
  const commands = retireTapCommands({ agents: agentsSource(), shepherd: shepherdReader(factory.port) }, { enabled, actionsDir: actionsDir(), client, now: () => clock });
  return {
    prepare: async (target: object = TARGET) => (await invokeCommand(commands["taps.prepare"], { target }, ownerContext())).envelope,
    act: (confirm: string, ctx = ownerContext()) => invokeCommand(commands["taps.act"], { target: TARGET, confirm }, ctx),
  };
}

const ready = (envelope: JsonEnvelope<unknown>) => z.object({ ok: z.literal(true), data: z.custom<Extract<TapPrepareResult, { status: "ready" }>>((data) => z.object({ status: z.literal("ready") }).safeParse(data).success) }).parse(envelope).data;

describe("taps.prepare on an agent page", () => {
  it("reads an exited agent back from the factory's preview with a confirm, previewing a plain retire", async () => {
    const { prepare } = await harness(spyFactory().client);

    const prepared = ready(await prepare());

    expect(prepared.readBack).toMatchObject({ agent: NAME, agentId: AGENT_ID, state: "exited", authority: "RET-OR: allow", proposedBy: "you", effect: expect.stringMatching(/^Retire item-42 \(9e3faa6\)/) });
    expect(previews).toEqual([{ kind: "retire-agent", name: NAME, agentId: AGENT_ID, force: false }]);
  });

  it.each([
    ["a live agent with no merged PR", () => (sessions = [{ name: NAME, workingOn: "EX-1: build", cwd: "/work/tree", status: "working", idleMs: 500, registeredAt: 95_000 }]), NAME, /retire a working agent at the terminal/],
    ["a seat", () => (events = [spawned("tpc-seat", "seat-1", 1_000), exited("tpc-seat", 2_000)]), "tpc-seat", /a seat is retired by its owner session/],
    ["a name no agent holds", () => (events = []), NAME, /nothing to retire/],
  ])("answers no-action for %s, without asking the factory", async (_label, arrange, name, reason) => {
    arrange();
    const { prepare } = await harness(spyFactory().client);

    const envelope = await prepare({ kind: "retire-agent", name });

    expect(envelope).toMatchObject({ ok: true, data: { status: "no-action", reason: expect.stringMatching(reason) } });
    expect(previews).toEqual([]);
  });

  it("a live agent inside the grace period offers no force retire", async () => {
    sessions = [{ name: NAME, workingOn: "EX-1: build", cwd: "/work/tree", status: "available", idleMs: 500, registeredAt: 99_000 }];
    const { prepare } = await harness(spyFactory().client);

    const live = await prepare();
    const forced = await prepare({ ...TARGET, force: true });

    expect(live).toMatchObject({ ok: true, data: { status: "no-action" } });
    expect(forced.ok).toBe(false);
    expect(previews).toEqual([]);
  });

  it("answers that inbox actions are off when they are", async () => {
    const { prepare } = await harness(spyFactory().client, false);

    expect(await prepare()).toMatchObject({ ok: false, error: expect.stringMatching(/inbox actions are off/) });
  });
});

describe("taps.act on an agent page", () => {
  it("writes the op record once with the read-back and posts its id, showing the broker's caveats", async () => {
    const factorySpy = spyFactory();
    const { prepare, act } = await harness(factorySpy.client);
    const { confirm } = ready(await prepare());

    const { envelope } = await act(confirm);

    expect(envelope).toMatchObject({ ok: true, data: { outcome: { status: "retired" }, message: "Retired item-42; the process had already exited" } });
    expect(JSON.parse(factorySpy.posted[0]!.bytes)).toMatchObject({ op: { kind: "retire-agent", name: NAME, agentId: AGENT_ID, force: false }, readBack: { agentId: AGENT_ID }, session: { issuedAt: 1_000 }, peer: "lan-remote" });
    expect(JSON.parse(await readFile(path.join(actionsDir(), `${confirm}.outcome.json`), "utf8"))).toMatchObject({ status: "retired", name: NAME });
  });

  it.each([
    ["loopback", ownerContext(null)],
    ["a bearer", ownerContext({ credential: "bearer", issuedAt: null, peerLocal: false })],
    ["a same-machine peer", ownerContext({ ...SESSION, peerLocal: true })],
    ["owner writes off", ownerContext(SESSION, false)],
  ])("refuses %s with no record and no post", async (_label, ctx) => {
    const factorySpy = spyFactory();
    const { prepare, act } = await harness(factorySpy.client);
    const { confirm } = ready(await prepare());

    const { envelope, exitCode } = await act(confirm, ctx);

    expect(exitCode).toBe(EXIT.NOPERM);
    expect(envelope.ok).toBe(false);
    expect(await records()).toEqual([]);
    expect(factorySpy.posted).toEqual([]);
  });

  it("refuses CHANGED when another agent took the name between prepare and act", async () => {
    const factorySpy = spyFactory();
    const { prepare, act } = await harness(factorySpy.client);
    const { confirm } = ready(await prepare());
    events = [...events, spawned(NAME, OTHER_ID, 95_000), exited(NAME, 96_000)];
    holderId = OTHER_ID;

    const { envelope, exitCode } = await act(confirm);

    expect(exitCode).toBe(EXIT.DATAERR);
    expect(envelope).toMatchObject({ ok: false, error: expect.stringMatching(/changed since it was read/) });
    expect(factorySpy.posted).toEqual([]);
  });

  it("a moved agent shows moved with its current id", async () => {
    const { prepare, act } = await harness(spyFactory({ status: "moved", currentHead: null, currentAgentId: OTHER_ID }).client);
    const { confirm } = ready(await prepare());

    const { envelope } = await act(confirm);

    expect(envelope).toMatchObject({ ok: true, data: { outcome: { status: "moved", currentAgentId: OTHER_ID }, message: expect.stringContaining("different agent (77aa001)") } });
  });

  it("reposts the identical record bytes on a replayed confirm and shows already", async () => {
    const factorySpy = spyFactory();
    const { prepare, act } = await harness(factorySpy.client);
    const { confirm } = ready(await prepare());
    await act(confirm);
    events = [];

    const { envelope } = await act(confirm);

    expect(envelope).toMatchObject({ ok: true, data: { outcome: { status: "already" }, message: "Already retired by this confirmation" } });
    expect(factorySpy.posted.map((post) => post.bytes)).toEqual([factorySpy.posted[0]!.bytes, factorySpy.posted[0]!.bytes]);
  });
});
