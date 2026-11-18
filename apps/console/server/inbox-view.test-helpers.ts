import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach } from "vitest";
import { z } from "zod";
import { silentLogger, type DaemonHandle } from "@titan-design/daemon";
import { depositItemId, type OwnerItem } from "@titan-design/owner-queue";
import { writeDeposit } from "@titan-design/owner-queue/spool";
import { MANIFEST_SCHEMA_ID, SHIP_OPTIONS, type ManifestInput } from "@titan-design/review-schema";
import type { ConsoleConfig } from "./config.js";
import { startConsoleDaemon } from "./daemon.js";
import type { InboxView, WatchRow } from "./inbox-view.js";
import { send, startFakeBroker, startFakeDaemon, type FakeBroker, type FakeDaemon, type RpcAnswer } from "./test-support.js";

export const REPO = "example/repo";
export const HEAD = "1234567890abcdef1234567890abcdef12345678";
export const ASKER = "test-asker";
export const RUN_PLAIN = "11111111-0000-4000-8000-000000000001";
export const RUN_OWNER = "22222222-0000-4000-8000-000000000002";
export const RUN_G10 = "33333333-0000-4000-8000-000000000003";
export const RUN_GONE = "44444444-0000-4000-8000-000000000004";

export const TOKEN = "synthetic-token";
/** The asker the fixtures' deposit and chat ask wait on, live in the broker so they stay blocking. */
const LIVE_ASKER = { name: ASKER, workingOn: "EX-2: waiting on the owner", cwd: "/synthetic/asker", status: "available", idleMs: 0, registeredAt: 1_000 };
export const MINUTE = 60_000;

/** The run's live fixtures: each test file owns one, and `useInboxViewWorld` starts and tears them down around every test. */
export interface World {
  dir: string;
  factory: FakeDaemon | undefined;
  broker: FakeBroker;
  handle: DaemonHandle | undefined;
}

export const emptyWorld = (): World => ({ dir: "", factory: undefined, broker: { port: 0, close: async () => undefined, requests: [], responseBytes: [] }, handle: undefined });

export function item(id: string, overrides: Partial<OwnerItem> = {}): OwnerItem {
  return {
    id,
    sources: [{ system: "agent-chat", ref: id }],
    kind: "decide",
    door: "two-way",
    summary: `Settle ${id}?`,
    context: "",
    keys: [],
    personal: false,
    lens: "blocking-agent",
    unblocks: [],
    openedAt: "2026-10-01T00:00:00.000Z",
    status: "open",
    ...overrides,
  };
}

export function gate(runId: string, openedAt: string, step = "approve-merge"): OwnerItem {
  const gateId = `${runId}/${step}`;
  return item(`gate:${gateId}`, {
    sources: [{ system: "hitl", ref: gateId }],
    kind: "approve",
    door: "one-way",
    lens: "blocking-merge",
    keys: [`gate:${gateId}`, `run:${runId}`],
    command: `titan-factory gate resolve ${runId} ${step} --json '<payload>'`,
    evidenceRef: `https://example.test/${REPO}/pull/${runId.slice(0, 1)}`,
    openedAt,
  });
}

export function row(runId: string, pr: number, held: string | null = null): WatchRow {
  return {
    repo: REPO,
    pr,
    branch: `feat/${pr}`,
    runId,
    task: "EX-1",
    phase: "awaiting-approval",
    headSha: HEAD,
    phaseSince: "2026-10-10T00:00:00.000Z",
    nextAction: "owner: resolve approve-merge",
    pendingGate: { gateId: `${runId}/approve-merge`, stepId: "approve-merge", since: "2026-10-10T00:00:00.000Z" },
    held: held === null ? null : { reason: held },
    stalled: null,
  };
}

const chatAsk = item("chat:msg-7", { sources: [{ system: "agent-chat", ref: "msg-7" }], asker: ASKER, openedAt: "2026-10-10T02:00:00.000Z" });
const morning = item("morning:m-1", { sources: [{ system: "morning", ref: "m-1" }], evidenceRef: "https://example.test/morning/m-1", openedAt: "2026-10-10T00:30:00.000Z" });
const planningTask = item("task:EX-9", { sources: [{ system: "active-work", ref: "example/EX-9" }], lens: "planning", openedAt: "2026-10-11T00:00:00.000Z" });

export const FACTORY_ITEMS = [
  gate(RUN_PLAIN, "2026-10-10T03:00:00.000Z"),
  gate(RUN_OWNER, "2026-10-10T05:00:00.000Z"),
  gate(RUN_G10, "2026-10-10T04:00:00.000Z"),
  gate(RUN_GONE, "2026-10-09T00:00:00.000Z"),
  chatAsk,
  morning,
  planningTask,
];

export const ROWS = [row(RUN_PLAIN, 1), row(RUN_OWNER, 2, "owner-asked: wait for me"), row(RUN_G10, 3, "g10-review: opus review at head")];

type Question = ManifestInput["questions"][number];

export const fixtureFactory: RpcAnswer = (command) => {
  if (command === "needs.list") return { items: FACTORY_ITEMS, gaps: [] };
  if (command === "shepherd.list") return ROWS;
  throw new Error(`no fixture for ${command}`);
};

export const okEnvelope = z.object({ ok: z.literal(true), data: z.custom<InboxView>() });

export const byId = (list: InboxView, id: string): InboxView["items"][number] | undefined => list.items.find((each) => each.id === id);

function config(world: World, factoryPort: number): ConsoleConfig {
  return {
    port: 0,
    stateDir: path.join(world.dir, "state"),
    activeWorkPort: 1,
    agentChatPort: world.broker.port,
    factoryPort,
    agentChatTokenPath: path.join(world.dir, "ui.token"),
    agentChatEventsDbPath: path.join(world.dir, "events.db"),
    seatPrefixes: [],
    sessionGraphPath: path.join(world.dir, "graph.sqlite3"),
    codewatchUrl: "http://codewatch.test:7433",
    lanHost: null,
    lanNames: [],
    lanTls: null,
    lanTokenPath: path.join(world.dir, "state", "lan.token"),
    ownerWrites: false,
    gateAnswers: false,
    inboxDir: path.join(world.dir, "state", "inbox", "deposits"),
    roundsDir: path.join(world.dir, "state", "rounds"),
    decisionsFile: null,
  };
}

async function writeShipRound(world: World, id: string, at: Date): Promise<void> {
  const question: Question = { id: "ship", kind: "pick-one", prompt: "Ship?", options: [...SHIP_OPTIONS], required: true, page: `${REPO}#5`, signsOff: "change", merge: { repo: REPO, pr: 5, headSha: HEAD, ship: ["Ship"] } };
  const parts = [{ id: "change", label: "The change", proposed: "ship()", lang: "ts" }];
  const sections = [{ id: "all", title: "All", deciding: "Whether it ships", changed: "The ship path", context: "Nothing else", parts, questionIds: ["ship"] }];
  const round: ManifestInput = { schema: MANIFEST_SCHEMA_ID, unit: id, round: 1, storybookUrl: "http://127.0.0.1:6006", widths: [1280], variants: [], sections, questions: [question] };
  const roundDir = path.join(world.dir, "state", "rounds", id);
  await mkdir(roundDir, { recursive: true });
  await writeFile(path.join(roundDir, "round.json"), JSON.stringify(round));
  await utimes(path.join(roundDir, "round.json"), at, at);
}

/** The owner command queue files a gate it saw as a deposit; the deposit carries the gate's key, which must win it nothing. */
async function writeImpostorDeposit(world: World): Promise<string> {
  await writeDeposit(path.join(world.dir, "state", "inbox", "deposits"), {
    depositId: "queue-1",
    asker: ASKER,
    kind: "do",
    door: "two-way",
    summary: "Resolve the plain gate",
    context: "",
    keys: [`gate:${RUN_PLAIN}/approve-merge`, `run:${RUN_PLAIN}`],
    command: "titan-factory shepherd waiting",
    unblocksNow: "the queue's next gate",
  });
  return depositItemId(ASKER, "queue-1");
}

async function listInbox(world: World, factoryPort: number, args: { planning?: boolean } = { planning: true }): Promise<InboxView> {
  world.handle = await startConsoleDaemon({ config: config(world, factoryPort), logger: silentLogger });
  const reply = await send("127.0.0.1", world.handle.port, "POST", "/rpc/inbox.list", { host: `127.0.0.1:${world.handle.port}`, "content-type": "application/json", "x-titan-client": "test" }, JSON.stringify(args));
  return okEnvelope.parse(JSON.parse(reply.body)).data;
}

async function serveFactory(world: World, rpc: RpcAnswer): Promise<number> {
  world.factory = await startFakeDaemon({ ok: true }, rpc);
  return world.factory.port;
}

/**
 * Starts a temp dir and a fake broker before each test and closes them after, in `world`, and hands back the writers and
 * readers that work on it: the rounds and deposits the console reads, and the `inbox.list` call itself.
 */
export function useInboxViewWorld(world: World) {
  beforeEach(async () => {
    world.dir = await mkdtemp(path.join(tmpdir(), "console-inbox-view-"));
    await writeFile(path.join(world.dir, "ui.token"), TOKEN, { mode: 0o600 });
    world.broker = await startFakeBroker({ token: TOKEN, sessions: [LIVE_ASKER], items: [] });
  });

  afterEach(async () => {
    await world.handle?.close();
    world.handle = undefined;
    await world.factory?.close();
    world.factory = undefined;
    await world.broker.close();
    await rm(world.dir, { recursive: true, force: true });
  });

  return {
    writeShipRound: (id: string, at: Date) => writeShipRound(world, id, at),
    writeImpostorDeposit: () => writeImpostorDeposit(world),
    listInbox: (factoryPort: number, args?: { planning?: boolean }) => listInbox(world, factoryPort, args),
    serveFactory: (rpc: RpcAnswer) => serveFactory(world, rpc),
  };
}
