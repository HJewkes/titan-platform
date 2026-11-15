import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RequestAuth } from "@titan-design/daemon";
import { depositItemId, type OwnerItemDeposit } from "@titan-design/owner-queue";
import { readAnswer, writeDeposit } from "@titan-design/owner-queue/spool";
import { withdrawDeposit } from "@titan-design/owner-queue/withdraw";
import { EXIT, invokeCommand, type JsonEnvelope } from "@titan-design/registry";
import { z } from "zod";
import { factoryNeeds } from "./factory.js";
import { inboxActionCommands, type PrepareResult } from "./inbox-actions.js";
import { readInbox } from "./inbox-view.js";
import type { OwnerActionClient } from "./owner-action.js";
import type { ConsoleContext } from "./owner-guard.js";
import { shepherdReader } from "./shepherd.js";
import { startFakeDaemon, type FakeDaemon } from "./test-support.js";

const ASKER = "pc-test-agent";
const SESSION: RequestAuth = { credential: "session", issuedAt: 1_000, peerLocal: false };
const context: ConsoleContext = { warnings: [], format: "json", surface: "http", auth: SESSION, ownerWrites: true };
const NOW = Date.parse("2026-10-10T06:00:00.000Z");

let dir: string;
let factory: FakeDaemon | undefined;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "console-deposit-answer-"));
});

afterEach(async () => {
  await factory?.close();
  factory = undefined;
  await rm(dir, { recursive: true, force: true });
});

function deposit(overrides: Record<string, unknown> = {}): OwnerItemDeposit {
  return {
    depositId: "daily-picks",
    asker: ASKER,
    kind: "decide",
    door: "two-way",
    summary: "Which video should the daily digest feature?",
    context: "Two candidates tied on score.",
    options: [
      { id: "first", label: "The first video" },
      { id: "second", label: "The second video" },
    ],
    recommended: { optionId: "second", by: ASKER, rationale: "Shorter" },
    ...overrides,
  };
}

const inboxDir = () => path.join(dir, "deposits");
const actionsDir = () => path.join(dir, "owner-actions");
const idOf = (depositId = "daily-picks") => depositItemId(ASKER, depositId);

async function harness() {
  factory = await startFakeDaemon({ ok: true }, (command) => {
    if (command === "needs.list") return { items: [], gaps: [] };
    if (command === "shepherd.list") return [];
    throw new Error(`no fixture for ${command}`);
  });
  const sources = { factory: factoryNeeds(factory.port), shepherd: shepherdReader(factory.port), rounds: { dir: path.join(dir, "rounds") }, inbox: { dir: inboxDir() }, now: () => NOW };
  const posted: string[] = [];
  const client: OwnerActionClient = { post: async (confirm) => (posted.push(confirm), { status: "gone", reason: "a deposit answer never posts to the factory" }) };
  const commands = inboxActionCommands(sources, { enabled: true, actionsDir: actionsDir(), client, now: () => NOW });
  return {
    sources,
    posted,
    prepare: async (itemId = idOf()) => (await invokeCommand(commands["inbox.prepare"], { itemId }, context)).envelope,
    act: (itemId: string, confirm: string, tap: { optionId?: string; text?: string }) => invokeCommand(commands["inbox.act"], { itemId, confirm, ...tap }, context),
  };
}

type Ready = Extract<PrepareResult, { status: "ready" }>;

const readyEnvelope = z.object({ ok: z.literal(true), data: z.custom<Ready>((data) => z.object({ status: z.literal("ready") }).safeParse(data).success) });

const readyOf = (envelope: JsonEnvelope<unknown>): Ready => readyEnvelope.parse(envelope).data;

describe("answering a plain deposit from the inbox", () => {
  it("offers the answer tap, not the terminal, with the question, options and recommended pick read back", async () => {
    await writeDeposit(inboxDir(), deposit());
    const { prepare } = await harness();

    const prepared = readyOf(await prepare());

    expect(prepared.status).toBe("ready");
    expect(prepared.action.kind).toBe("answer-deposit");
    expect(prepared.readBack).toMatchObject({ question: "Two candidates tied on score.", options: [{ id: "first" }, { id: "second" }], recommended: "second" });
  });

  it("writes the picked option once as the owner's answer and the deposit leaves the open list", async () => {
    await writeDeposit(inboxDir(), deposit());
    const { prepare, act, sources } = await harness();
    const { confirm } = readyOf(await prepare());

    const done = await act(idOf(), confirm, { optionId: "first" });

    expect(done.envelope).toMatchObject({ ok: true, data: { outcome: { status: "answered" } } });
    expect(await readAnswer(inboxDir(), idOf())).toEqual({ optionId: "first", by: { class: "owner-remote", channel: "console:inbox", id: "titan-console" }, at: new Date(NOW).toISOString() });
    expect((await readInbox(sources)).items.map((item) => item.id)).not.toContain(idOf());
  });

  it("writes a free-text answer", async () => {
    await writeDeposit(inboxDir(), deposit({ options: undefined, recommended: undefined }));
    const { prepare, act } = await harness();
    const { confirm } = readyOf(await prepare());

    await act(idOf(), confirm, { text: "  Feature neither; run it tomorrow.  " });

    expect(await readAnswer(inboxDir(), idOf())).toMatchObject({ text: "Feature neither; run it tomorrow.", at: new Date(NOW).toISOString() });
  });

  it("answers already and writes nothing new when the same confirm is replayed", async () => {
    await writeDeposit(inboxDir(), deposit());
    const { prepare, act } = await harness();
    const { confirm } = readyOf(await prepare());
    await act(idOf(), confirm, { optionId: "first" });
    const filed = (await readdir(inboxDir())).sort();

    const replay = await act(idOf(), confirm, { optionId: "second" });

    expect(replay.envelope).toMatchObject({ ok: true, data: { outcome: { status: "already" } } });
    expect(await readAnswer(inboxDir(), idOf())).toMatchObject({ optionId: "first" });
    expect((await readdir(inboxDir())).sort()).toEqual(filed);
  });

  it("refuses a deposit withdrawn between prepare and act and files no answer", async () => {
    await writeDeposit(inboxDir(), deposit());
    const { prepare, act } = await harness();
    const { confirm } = readyOf(await prepare());
    await withdrawDeposit(inboxDir(), idOf(), { reason: "obsolete", as: ASKER, actor: ASKER });

    const refused = await act(idOf(), confirm, { optionId: "first" });

    expect(refused.exitCode).toBe(EXIT.DATAERR);
    expect(await readAnswer(inboxDir(), idOf())).toBeUndefined();
  });

  it("keeps an op deposit on its owner-op tap", async () => {
    await writeDeposit(inboxDir(), deposit({ depositId: "retire-one", op: { kind: "retire-agent", name: "synthetic-seat", agentId: "synthetic-id", force: false } }));
    const { sources } = await harness();

    const list = await readInbox(sources);

    expect(list.items.find((item) => item.id === idOf("retire-one"))?.action.kind).toBe("owner-op");
  });
});
