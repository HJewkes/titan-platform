import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BrokerEvent, BrokerSession } from "@titan-design/chat-protocol/agents";
import type { RequestAuth } from "@titan-design/daemon";
import { EXIT, invokeCommand, type JsonEnvelope } from "@titan-design/registry";
import { partialFake } from "@titan-design/test-kit";
import type { AgentsSource } from "./agents.js";
import type { BrokerReader } from "./broker.js";
import type { OwnerActionClient } from "./owner-action.js";
import type { ConsoleContext } from "./owner-guard.js";
import { retireTapCommands, type TapPrepareResult } from "./retire-tap.js";
import { shepherdReader } from "./shepherd.js";
import { startFakeDaemon, type FakeDaemon } from "./test-support.js";

const NAME = "item-42";
const AGENT_ID = "9e3faa6c0011";
const PLAIN = { kind: "retire-agent", name: NAME } as const;
const FORCED = { ...PLAIN, force: true } as const;
const SESSION: RequestAuth = { credential: "session", issuedAt: 1_000, peerLocal: false };
const GRACE_MS = 120_000;

let dir: string;
let factory: FakeDaemon | undefined;
let sessions: BrokerSession[];
let clock: number;
/** The exit time agent-chat's roster reports to the factory: undefined for a row that carries none. */
let exitedAt: number | undefined;
/** Whether the factory's preview predates `forceStop`. */
let olderFactory: boolean;
let previews: unknown[];

const events = (): BrokerEvent[] => [
  { msgId: AGENT_ID, kind: "agent_spawned", from: "coordinator", text: "brief", at: 1_000, meta: { target: NAME, profile: "impl" } },
  { msgId: `x-${NAME}`, kind: "agent_exited", from: NAME, text: "", at: 2_000, meta: {} },
];

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "console-retire-force-"));
  sessions = [];
  clock = 1_000_000;
  exitedAt = clock - 3 * GRACE_MS;
  olderFactory = false;
  previews = [];
});

afterEach(async () => {
  await factory?.close();
  factory = undefined;
  await rm(dir, { recursive: true, force: true });
});

const actionsDir = () => path.join(dir, "owner-actions");

function agentsSource(): AgentsSource {
  const broker = partialFake<BrokerReader>({ read: async () => ({ sessions, brokerUptimeMs: 60_000, events: events() }) });
  return { broker, eventsDbPath: path.join(dir, "events.db"), seatPrefixes: [], now: () => clock };
}

/** The factory's grace rule as its preview answers it, so the console offers force exactly when the factory would accept it. */
function forceStopOf(): string | null {
  if (exitedAt === undefined) return `agent-chat reports no exit time for ${NAME}, so the grace a forced retire waits out cannot be checked; force it at the terminal`;
  const wait = exitedAt + GRACE_MS - clock;
  return wait > 0 ? `Wait ${Math.ceil(wait / 1000)} s: agent-chat keeps a just-exited agent's worktree for 2 minutes so unpushed work is not lost` : null;
}

function retirePreview() {
  const holder = { agentId: AGENT_ID, state: "exited", presence: "exited", status: "finished", profile: "impl", cwd: "/work/tree", spawnedBy: "coordinator", ...(exitedAt !== undefined && { exitedAt: new Date(exitedAt).toISOString() }) };
  return { kind: "retire-agent", authority: { verdict: "allow", ruleId: "RET-OR" }, agent: { name: NAME, holder, exited: true, liveRun: null, ...(!olderFactory && { forceStop: forceStopOf() }) } };
}

/** The factory route as the console sees it: it accepts the record it is posted and retires the agent. */
function spyFactory() {
  const posted: string[] = [];
  const client: OwnerActionClient = {
    post: async (actionId) => {
      posted.push(await readFile(path.join(actionsDir(), `${actionId}.json`), "utf8"));
      return { status: "retired", name: NAME, caveats: ["removed the worktree and deleted its branch"] };
    },
  };
  return { client, posted };
}

const ownerContext = (): ConsoleContext => ({ warnings: [], format: "json", surface: "http", auth: SESSION, ownerWrites: true });

async function harness(client: OwnerActionClient) {
  factory = await startFakeDaemon({ ok: true }, (command, args) => {
    if (command !== "owner-op.preview") throw new Error(`no fixture for ${command}`);
    previews.push(args.op);
    return retirePreview();
  });
  const commands = retireTapCommands({ agents: agentsSource(), shepherd: shepherdReader(factory.port) }, { enabled: true, actionsDir: actionsDir(), client, now: () => clock });
  return {
    prepare: async (target: object) => (await invokeCommand(commands["taps.prepare"], { target }, ownerContext())).envelope as JsonEnvelope<TapPrepareResult>,
    act: (confirm: string) => invokeCommand(commands["taps.act"], { target: FORCED, confirm }, ownerContext()),
  };
}

type Ready = Extract<TapPrepareResult, { status: "ready" }>;

function ready(envelope: JsonEnvelope<TapPrepareResult>): Ready {
  if (!envelope.ok || envelope.data.status !== "ready") throw new Error(`not ready: ${JSON.stringify(envelope)}`);
  return envelope.data;
}

describe("the agent page's forced retire", () => {
  it("a live agent offers no force retire", async () => {
    sessions = [{ name: NAME, workingOn: "EX-1: build", cwd: "/work/tree", status: "working", idleMs: 500, registeredAt: 999_000 }];
    const { prepare } = await harness(spyFactory().client);

    const forced = await prepare(FORCED);

    expect(forced).toMatchObject({ ok: true, data: { status: "no-action", reason: expect.stringMatching(/retire a working agent at the terminal/) } });
    expect(previews).toEqual([]);
  });

  it("an agent exited inside the grace offers no force retire", async () => {
    exitedAt = clock - 60_000;
    const { prepare } = await harness(spyFactory().client);

    const plain = ready(await prepare(PLAIN));
    const forced = await prepare(FORCED);

    expect(plain.forceStop).toMatch(/^Wait 60 s/);
    expect(forced).toMatchObject({ ok: true, data: { status: "no-action", reason: expect.stringMatching(/^Wait 60 s/) } });
  });

  it("an agent exited past the grace offers force retire and the factory accepts it", async () => {
    const factorySpy = spyFactory();
    const { prepare, act } = await harness(factorySpy.client);

    const plain = ready(await prepare(PLAIN));
    const forced = ready(await prepare(FORCED));
    const { envelope } = await act(forced.confirm);

    expect(plain.forceStop).toBeNull();
    expect(forced.readBack).toMatchObject({ exitedAt: new Date(clock - 3 * GRACE_MS).toISOString(), effect: expect.stringMatching(/^Retire item-42 \(9e3faa6\) with --force: discard/) });
    expect(JSON.parse(factorySpy.posted[0]!)).toMatchObject({ op: { kind: "retire-agent", name: NAME, agentId: AGENT_ID, force: true }, target: FORCED });
    expect(envelope).toMatchObject({ ok: true, data: { outcome: { status: "retired" }, message: "Retired item-42; removed the worktree and deleted its branch" } });
  });

  it("a roster row without exitedAt offers no force", async () => {
    exitedAt = undefined;
    const { prepare } = await harness(spyFactory().client);

    const plain = ready(await prepare(PLAIN));
    const forced = await prepare(FORCED);

    expect(plain).toMatchObject({ readBack: { exitedAt: null }, forceStop: expect.stringMatching(/no exit time/) });
    expect(forced).toMatchObject({ ok: true, data: { status: "no-action", reason: expect.stringMatching(/no exit time/) } });
  });

  it("an older factory whose preview reports no grace offers no force", async () => {
    olderFactory = true;
    const { prepare } = await harness(spyFactory().client);

    const forced = await prepare(FORCED);

    expect(forced).toMatchObject({ ok: true, data: { status: "no-action", reason: expect.stringMatching(/does not report agent-chat's grace/) } });
  });

  it("refuses CHANGED when the exit time moved between the forced prepare and act, and posts nothing", async () => {
    const factorySpy = spyFactory();
    const { prepare, act } = await harness(factorySpy.client);
    const { confirm } = ready(await prepare(FORCED));
    exitedAt = clock - 2 * GRACE_MS;

    const { envelope, exitCode } = await act(confirm);

    expect(exitCode).toBe(EXIT.DATAERR);
    expect(envelope).toMatchObject({ ok: false, error: expect.stringMatching(/changed since it was read/) });
    expect(factorySpy.posted).toEqual([]);
  });
});
