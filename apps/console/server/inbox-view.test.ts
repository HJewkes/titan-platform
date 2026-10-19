import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { silentLogger, type DaemonHandle } from "@titan-design/daemon";
import { depositItemId, type OwnerItem } from "@titan-design/owner-queue";
import { writeDeposit } from "@titan-design/owner-queue/spool";
import { MANIFEST_SCHEMA_ID, SHIP_OPTIONS, type ManifestInput } from "@titan-design/review-schema";
import type { ConsoleConfig } from "./config.js";
import { startConsoleDaemon } from "./daemon.js";
import { BLOCKED_AGENT_AFTER_MS, STALLED_RUN_AFTER_MS } from "./inbox-derived.js";
import { actionFor, inboxItems, type InboxItem, type InboxView, type WatchRow } from "./inbox-view.js";
import { closedPort, send, startFakeBroker, startFakeDaemon, type FakeBroker, type FakeDaemon, type RpcAnswer } from "./test-support.js";

const REPO = "example/repo";
const HEAD = "1234567890abcdef1234567890abcdef12345678";
const ASKER = "test-asker";
const RUN_PLAIN = "11111111-0000-4000-8000-000000000001";
const RUN_OWNER = "22222222-0000-4000-8000-000000000002";
const RUN_G10 = "33333333-0000-4000-8000-000000000003";
const RUN_GONE = "44444444-0000-4000-8000-000000000004";

const TOKEN = "synthetic-token";
const MINUTE = 60_000;

let dir: string;
let factory: FakeDaemon | undefined;
let broker: FakeBroker;
let handle: DaemonHandle | undefined;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "console-inbox-view-"));
  await writeFile(path.join(dir, "ui.token"), TOKEN, { mode: 0o600 });
  broker = await startFakeBroker({ token: TOKEN, sessions: [], items: [] });
});

afterEach(async () => {
  await handle?.close();
  handle = undefined;
  await factory?.close();
  factory = undefined;
  await broker.close();
  await rm(dir, { recursive: true, force: true });
});

function item(id: string, overrides: Partial<OwnerItem> = {}): OwnerItem {
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

function gate(runId: string, openedAt: string, step = "approve-merge"): OwnerItem {
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

function row(runId: string, pr: number, held: string | null = null): WatchRow {
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

const FACTORY_ITEMS = [
  gate(RUN_PLAIN, "2026-10-10T03:00:00.000Z"),
  gate(RUN_OWNER, "2026-10-10T05:00:00.000Z"),
  gate(RUN_G10, "2026-10-10T04:00:00.000Z"),
  gate(RUN_GONE, "2026-10-09T00:00:00.000Z"),
  chatAsk,
  morning,
  planningTask,
];

const ROWS = [row(RUN_PLAIN, 1), row(RUN_OWNER, 2, "owner-asked: wait for me"), row(RUN_G10, 3, "g10-review: opus review at head")];

type Question = ManifestInput["questions"][number];

async function writeShipRound(id: string, at: Date): Promise<void> {
  const question: Question = { id: "ship", kind: "pick-one", prompt: "Ship?", options: [...SHIP_OPTIONS], required: true, page: `${REPO}#5`, signsOff: "change", merge: { repo: REPO, pr: 5, headSha: HEAD, ship: ["Ship"] } };
  const parts = [{ id: "change", label: "The change", proposed: "ship()", lang: "ts" }];
  const sections = [{ id: "all", title: "All", deciding: "Whether it ships", changed: "The ship path", context: "Nothing else", parts, questionIds: ["ship"] }];
  const round: ManifestInput = { schema: MANIFEST_SCHEMA_ID, unit: id, round: 1, storybookUrl: "http://127.0.0.1:6006", widths: [1280], variants: [], sections, questions: [question] };
  const roundDir = path.join(dir, "state", "rounds", id);
  await mkdir(roundDir, { recursive: true });
  await writeFile(path.join(roundDir, "round.json"), JSON.stringify(round));
  await utimes(path.join(roundDir, "round.json"), at, at);
}

/** The owner command queue files a gate it saw as a deposit; the deposit carries the gate's key, which must win it nothing. */
async function writeImpostorDeposit(): Promise<string> {
  await writeDeposit(path.join(dir, "state", "inbox", "deposits"), {
    depositId: "queue-1",
    asker: ASKER,
    kind: "do",
    door: "two-way",
    summary: "Resolve the plain gate",
    context: "",
    keys: [`gate:${RUN_PLAIN}/approve-merge`, `run:${RUN_PLAIN}`],
    command: "titan-factory shepherd waiting",
  });
  return depositItemId(ASKER, "queue-1");
}

function config(factoryPort: number): ConsoleConfig {
  return {
    port: 0,
    stateDir: path.join(dir, "state"),
    activeWorkPort: 1,
    agentChatPort: broker.port,
    factoryPort,
    agentChatTokenPath: path.join(dir, "ui.token"),
    agentChatEventsDbPath: path.join(dir, "events.db"),
    seatPrefixes: [],
    sessionGraphPath: path.join(dir, "graph.sqlite3"),
    codewatchUrl: "http://codewatch.test:7433",
    lanHost: null,
    lanNames: [],
    lanTls: null,
    lanTokenPath: path.join(dir, "state", "lan.token"),
    ownerWrites: false,
    gateAnswers: false,
    inboxDir: path.join(dir, "state", "inbox", "deposits"),
    roundsDir: path.join(dir, "state", "rounds"),
    decisionsFile: null,
  };
}

const fixtureFactory: RpcAnswer = (command) => {
  if (command === "needs.list") return { items: FACTORY_ITEMS, gaps: [] };
  if (command === "shepherd.list") return ROWS;
  throw new Error(`no fixture for ${command}`);
};

const okEnvelope = z.object({ ok: z.literal(true), data: z.custom<InboxView>() });

async function listInbox(factoryPort: number): Promise<InboxView> {
  handle = await startConsoleDaemon({ config: config(factoryPort), logger: silentLogger });
  const reply = await send("127.0.0.1", handle.port, "POST", "/rpc/inbox.list", { host: `127.0.0.1:${handle.port}`, "content-type": "application/json", "x-titan-client": "test" }, "{}");
  return okEnvelope.parse(JSON.parse(reply.body)).data;
}

async function serveFactory(rpc: RpcAnswer): Promise<number> {
  factory = await startFakeDaemon({ ok: true }, rpc);
  return factory.port;
}

const byId = (list: InboxView, id: string): InboxItem | undefined => list.items.find((each) => each.id === id);

describe("inbox.list on a fixture factory", () => {
  it("returns every source kind with its action, blocking first and newest first", async () => {
    await writeShipRound("ship-r1", new Date("2026-10-10T01:00:00.000Z"));
    const depositId = await writeImpostorDeposit();

    const list = await listInbox(await serveFactory(fixtureFactory));

    expect(list.gaps).toEqual([]);
    expect(list.items.map((each) => [each.id, each.section, each.action.kind])).toEqual([
      [depositId, "blocking", "terminal"],
      [`gate:${RUN_OWNER}/approve-merge`, "blocking", "owner-release"],
      [`gate:${RUN_G10}/approve-merge`, "blocking", "hold-release"],
      [`gate:${RUN_PLAIN}/approve-merge`, "blocking", "resolve-gate"],
      ["chat:msg-7", "blocking", "answer-chat"],
      ["round:ship-r1/ship", "blocking", "open-round"],
      ["morning:m-1", "blocking", "open"],
      [`gate:${RUN_GONE}/approve-merge`, "blocking", "terminal"],
      ["task:EX-9", "planning", "open"],
    ]);
    expect(byId(list, `gate:${RUN_G10}/approve-merge`)).toMatchObject({ hold: { class: "g10-review" }, action: { holdClass: "g10-review", pr: 3, headSha: HEAD }, then: { kind: "resolve-gate" } });
    expect(byId(list, `gate:${RUN_PLAIN}/approve-merge`)?.action).toEqual({ kind: "resolve-gate", gateId: `${RUN_PLAIN}/approve-merge`, runId: RUN_PLAIN, stepId: "approve-merge", repo: REPO, pr: 1, headSha: HEAD, decision: "merge" });
    expect(byId(list, `gate:${RUN_GONE}/approve-merge`)?.action).toMatchObject({ command: `titan-factory gate resolve ${RUN_GONE} approve-merge --json '<payload>'` });
    expect(byId(list, "task:EX-9")).toMatchObject({ evidence: "#/tasks/EX-9", action: { route: "#/tasks/EX-9" } });
    expect(byId(list, "round:ship-r1/ship")).toMatchObject({ evidence: "#/rounds/ship-r1", action: { roundId: "ship-r1" } });
  });

  it("releases an owner-asked hold before the gate it holds is offered", async () => {
    const list = await listInbox(await serveFactory(fixtureFactory));

    expect(byId(list, `gate:${RUN_OWNER}/approve-merge`)).toMatchObject({
      hold: { class: "owner-asked", reason: "owner-asked: wait for me" },
      action: { kind: "owner-release", repo: REPO, pr: 2, headSha: HEAD },
      then: { kind: "resolve-gate", gateId: `${RUN_OWNER}/approve-merge` },
      evidence: `#/shepherd/${encodeURIComponent(`${REPO}#2`)}`,
    });
  });

  it("shows Shepherd being down as a gap and offers its gates on the terminal only", async () => {
    const list = await listInbox(
      await serveFactory((command) => {
        if (command === "needs.list") return { items: FACTORY_ITEMS, gaps: [] };
        throw new Error("shepherd store is locked");
      }),
    );

    expect(list.gaps).toEqual(["shepherd: factory shepherd.list: shepherd store is locked"]);
    expect(list.items.filter((each) => each.sources[0]!.system === "hitl").map((each) => each.action.kind)).toEqual(["terminal", "terminal", "terminal", "terminal"]);
  });

  it("lists the console's own deposits and rounds with a gap line per dead leg when the factory is down", async () => {
    await writeShipRound("ship-r1", new Date("2026-10-10T01:00:00.000Z"));
    const depositId = await writeImpostorDeposit();

    const list = await listInbox(await closedPort());

    expect(list.gaps).toHaveLength(2);
    expect(list.gaps.map((gap) => gap.slice(0, gap.indexOf(":")))).toEqual(["factory", "shepherd"]);
    expect(list.items.map((each) => each.id)).toEqual([depositId, "round:ship-r1/ship"]);
    expect(list.derived).toEqual([]);
  });
});

describe("inbox.list's machine-derived rows", () => {
  const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();
  const RUN_STALLED = "55555555-0000-4000-8000-000000000005";
  const RUN_FAILED = "66666666-0000-4000-8000-000000000006";
  const stalled = { ...row(RUN_STALLED, 5), phase: "ci", phaseSince: ago(75 * MINUTE), stalled: { reason: "75 min in ci, over the 60 min limit" } };
  const failed = { ...row(RUN_FAILED, 6), phase: "failed", phaseSince: ago(2 * 60 * MINUTE), stalled: { reason: "sh-ci exited 1" } };
  const shepherdByState: RpcAnswer = (command, args) => {
    if (command === "needs.list") return { items: [], gaps: [] };
    if (command === "shepherd.list") return args["state"] === "finished" ? [failed] : [stalled];
    throw new Error(`no fixture for ${command}`);
  };
  const blocked = { name: "relay-worker", workingOn: "EX-3: wire the relay", cwd: "/synthetic/relay", status: "blocked", idleMs: 40 * MINUTE, registeredAt: 1_000 };

  it("lists a stall, a failed run and a blocked agent, each with its evidence and crossed threshold and no action", async () => {
    await broker.close();
    broker = await startFakeBroker({ token: TOKEN, sessions: [blocked], items: [] });

    const list = await listInbox(await serveFactory(shepherdByState));

    expect(list.gaps).toEqual([]);
    expect(list.items).toEqual([]);
    expect(list.derived.map((each) => [each.kind, each.link])).toEqual([
      ["failed-run", `#/shepherd/${encodeURIComponent(`${REPO}#6`)}`],
      ["stalled-run", `#/shepherd/${encodeURIComponent(`${REPO}#5`)}`],
      ["blocked-agent", "#/agents/relay-worker"],
    ]);
    expect(list.derived[0]).toMatchObject({ evidence: { observed: "phase failed: sh-ci exited 1", source: `shepherd row ${RUN_FAILED}`, at: failed.phaseSince }, threshold: { name: "a failed run", limitMs: 0 } });
    expect(list.derived[1]).toMatchObject({ evidence: { observed: "stalled: 75 min in ci, over the 60 min limit", at: stalled.phaseSince }, threshold: { limitMs: STALLED_RUN_AFTER_MS } });
    expect(list.derived[2]).toMatchObject({ evidence: { observed: "presence blocked, silent for 40 min", source: "agent-chat presence" }, threshold: { limitMs: BLOCKED_AGENT_AFTER_MS } });
    expect(list.derived.every((each) => !("action" in each))).toBe(true);
  });

  it("names a dead broker as a gap and still derives Shepherd's rows", async () => {
    await broker.close();

    const list = await listInbox(await serveFactory(shepherdByState));

    expect(list.gaps.map((gap) => gap.slice(0, gap.indexOf(":")))).toEqual(["agents"]);
    expect(list.derived.map((each) => each.kind)).toEqual(["failed-run", "stalled-run"]);
  });
});

describe("actionFor", () => {
  it("gives a deposit carrying a live gate's key no write action", () => {
    const impostor = item("deposit:impostor", { sources: [{ system: "deposit", ref: `${ASKER}/impostor` }], keys: [`gate:${RUN_PLAIN}/approve-merge`, `run:${RUN_PLAIN}`], command: "titan-factory shepherd waiting" });

    const { action } = actionFor(impostor, row(RUN_PLAIN, 1));

    expect(action).toMatchObject({ kind: "terminal", command: "titan-factory shepherd waiting" });
  });

  it.each([
    ["device-flash", "a device or hardware gate"],
    ["after-stages", "an after-stages gate"],
  ])("keeps a %s gate on the terminal even with a live row", (step, reason) => {
    const { action } = actionFor(gate(RUN_PLAIN, "2026-10-10T00:00:00.000Z", step), row(RUN_PLAIN, 1));

    expect(action).toMatchObject({ kind: "terminal", command: `titan-factory gate resolve ${RUN_PLAIN} ${step} --json '<payload>'` });
    expect(action.kind === "terminal" && action.reason.startsWith(reason)).toBe(true);
  });

  it("answers a repeated approve-merge gate (`:<n>`) as the merge gate", () => {
    const repeated = item(`gate:${RUN_PLAIN}/approve-merge:2`, { sources: [{ system: "hitl", ref: `${RUN_PLAIN}/approve-merge:2` }] });

    expect(actionFor(repeated, row(RUN_PLAIN, 1)).action).toMatchObject({ kind: "resolve-gate", gateId: `${RUN_PLAIN}/approve-merge:2`, stepId: "approve-merge" });
  });

  it("leaves an agent's approval request on its own session", () => {
    const approval = item("chat:msg-8", { sources: [{ system: "agent-chat", ref: "msg-8" }], kind: "approve" });

    expect(actionFor(approval, undefined).action.kind).toBe("terminal");
  });
});

describe("inbox ordering", () => {
  it("puts the newest blocker first", () => {
    const older = gate(RUN_PLAIN, "2026-10-10T00:00:00.000Z");
    const newer = gate(RUN_G10, "2026-10-10T09:00:00.000Z");

    const items = inboxItems([older, newer], []);

    expect(items.map((each) => each.id)).toEqual([newer.id, older.id]);
  });

  it("orders 3000 live-sized items within 200 ms", () => {
    const many = Array.from({ length: 3000 }, (_, n) =>
      n % 3 === 0 ? gate(`${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`, new Date(Date.UTC(2026, 9, 1) + n * 1000).toISOString()) : item(`ask-${n}`, { lens: n % 2 === 0 ? "planning" : "blocking-agent" }),
    );
    const rows = many.filter((_, n) => n % 3 === 0).map((each, n) => row(each.sources[0]!.ref.slice(0, each.sources[0]!.ref.indexOf("/")), n + 1));

    const started = performance.now();
    const items = inboxItems(many, rows);

    expect(performance.now() - started).toBeLessThan(200);
    expect(items).toHaveLength(3000);
  });
});
