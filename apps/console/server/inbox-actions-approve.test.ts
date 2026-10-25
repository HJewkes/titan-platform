import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BrokerEvent } from "@titan-design/chat-protocol/agents";
import type { RequestAuth } from "@titan-design/daemon";
import type { OwnerItem } from "@titan-design/owner-queue";
import { EXIT, invokeCommand, type JsonEnvelope } from "@titan-design/registry";
import { z } from "zod";
import type { AgentsSource } from "./agents.js";
import type { BrokerReader } from "./broker.js";
import { brokerVerdicter, type BrokerVerdicter, type VerdictOutcome } from "./broker-verdict.js";
import type { DecisionLog } from "./decision-log.js";
import { factoryNeeds } from "./factory.js";
import { inboxActionCommands, type PrepareResult } from "./inbox-actions.js";
import { APPROVE_AT_SESSION } from "./inbox-approve-chat.js";
import type { OwnerActionClient } from "./owner-action.js";
import type { ConsoleContext } from "./owner-guard.js";
import { shepherdReader } from "./shepherd.js";
import { startFakeDaemon, type FakeDaemon } from "./test-support.js";

const MSG = "msg-0042";
const ITEM_ID = `chat:${MSG}`;
const TOKEN = "synthetic-ui-token-0123456789";

const SESSION: RequestAuth = { credential: "session", issuedAt: 1_000, peerLocal: false };
const BEARER: RequestAuth = { credential: "bearer", issuedAt: null, peerLocal: false };
const context = (auth: RequestAuth | null = SESSION): ConsoleContext => ({ warnings: [], format: "json", surface: "http", auth, ownerWrites: true });

let dir: string;
let factory: FakeDaemon | undefined;
let queue: BrokerEvent[];

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "console-inbox-approve-"));
  queue = [permissionRow()];
});

afterEach(async () => {
  await factory?.close();
  factory = undefined;
  await rm(dir, { recursive: true, force: true });
});

function permissionRow(): BrokerEvent {
  return { msgId: MSG, kind: "approval_request", from: "agent-1", text: "Bash: example command", at: 1_000, meta: { tool_name: "Bash", input_preview: "echo example" } };
}

function endorseRow(text: string): BrokerEvent {
  return { msgId: MSG, kind: "endorse_request", from: "agent-1", text, at: 1_000, meta: { recipient: "agent-2", recipient_durable: "true" } };
}

/** What the factory gives every one of these: an `approve` item that names the msg and carries none of the row's meta. */
function approveItem(): OwnerItem {
  return {
    id: ITEM_ID,
    sources: [{ system: "agent-chat", ref: MSG }],
    kind: "approve",
    door: "one-way",
    summary: "Bash: example command",
    context: "a summary that is not the stored text",
    keys: [],
    asker: "agent-1",
    personal: false,
    lens: "blocking-agent",
    unblocks: [],
    openedAt: "2026-10-10T04:00:00.000Z",
    status: "open",
  };
}

function stubBroker(): BrokerReader {
  const unused = () => Promise.reject(new Error("not read by these taps"));
  return { read: unused, history: unused, queue: async () => queue };
}

function spyVerdicter(outcome: VerdictOutcome = { status: "answered" }) {
  const calls: unknown[][] = [];
  const verdicter: BrokerVerdicter = {
    permission: async (...args) => {
      calls.push(["permission", ...args]);
      return outcome;
    },
    endorse: async (...args) => {
      calls.push(["endorse", ...args]);
      return outcome;
    },
  };
  return { verdicter, calls };
}

function spyLog() {
  const calls: Parameters<DecisionLog["record"]>[] = [];
  const log: DecisionLog = {
    record: async (...args) => {
      calls.push(args);
      return { ledger: "written", decisions: "not-configured" };
    },
  };
  return { log, calls };
}

const actionsDir = () => path.join(dir, "owner-actions");
const records = () => readdir(actionsDir()).catch(() => [] as string[]);

async function harness(verdicter: BrokerVerdicter, decisionLog?: DecisionLog) {
  factory = await startFakeDaemon({ ok: true }, (command) => {
    if (command === "needs.list") return { items: [approveItem()], gaps: [] };
    if (command === "shepherd.list") return [];
    throw new Error(`no fixture for ${command}`);
  });
  const agents: AgentsSource = { broker: stubBroker(), eventsDbPath: path.join(dir, "events.db"), seatPrefixes: [] };
  const sources = { factory: factoryNeeds(factory.port), shepherd: shepherdReader(factory.port), rounds: { dir: path.join(dir, "rounds") }, inbox: { dir: path.join(dir, "deposits") }, agents };
  const client: OwnerActionClient = { post: async () => ({ status: "gone", reason: "an approve-chat tap never posts to the factory" }) };
  const commands = inboxActionCommands(sources, { enabled: true, actionsDir: actionsDir(), client, verdicter, now: () => Date.parse("2026-10-10T06:00:00.000Z"), ...(decisionLog && { decisionLog }) });
  return {
    prepare: async () => (await invokeCommand(commands["inbox.prepare"], { itemId: ITEM_ID }, context())).envelope,
    act: (confirm: string, tap: { verdict?: string; text?: string } = { verdict: "allow" }, ctx = context()) => invokeCommand(commands["inbox.act"], { itemId: ITEM_ID, confirm, ...tap }, ctx),
  };
}

const readyEnvelope = z.object({ ok: z.literal(true), data: z.custom<Extract<PrepareResult, { status: "ready" }>>((data) => z.object({ status: z.literal("ready") }).safeParse(data).success) });
const ready = (envelope: JsonEnvelope<unknown>) => readyEnvelope.parse(envelope).data;

describe("inbox approve-chat prepare", () => {
  it("reads a permission prompt back from the broker row: tool, input preview and description, offering allow or deny", async () => {
    const { prepare } = await harness(spyVerdicter().verdicter);

    const prepared = ready(await prepare());

    expect(prepared.action).toEqual({ kind: "approve-chat", msgId: MSG });
    expect(prepared.readBack).toEqual({
      msgId: MSG,
      kind: "permission",
      tool: "Bash",
      inputPreview: "echo example",
      description: "Bash: example command",
      asker: "agent-1",
      choices: ["allow", "deny"],
      effect: "Answer agent-1's permission prompt for Bash; the broker records the verdict as yours, from the console",
    });
  });

  it("reads an endorsement back as the stored text and recipient, whitespace intact", async () => {
    queue = [endorseRow("hello \n")];
    const { prepare } = await harness(spyVerdicter().verdicter);

    const prepared = ready(await prepare());

    expect(prepared.readBack).toMatchObject({ msgId: MSG, kind: "endorse", text: "hello \n", to: "agent-2", asker: "agent-1" });
  });

  it("gives a needs-grant notice that the factory also shapes approve no tap", async () => {
    queue = [{ msgId: MSG, kind: "notice", from: "agent-1", text: "needs a grant for example scope", at: 1_000, meta: { kind: "needs-grant" } }];
    const spy = spyVerdicter();
    const { prepare } = await harness(spy.verdicter);

    const envelope = await prepare();

    expect(envelope).toMatchObject({ ok: true, data: { status: "no-action", reason: APPROVE_AT_SESSION } });
    expect(spy.calls).toEqual([]);
  });

  it("gives a permission prompt that names no tool no tap, so the owner never decides on the agent's words alone", async () => {
    queue = [{ ...permissionRow(), meta: { input_preview: "echo example" } }];
    const { prepare } = await harness(spyVerdicter().verdicter);

    expect(await prepare()).toMatchObject({ ok: true, data: { status: "no-action", reason: APPROVE_AT_SESSION } });
  });

  it("gives no tap when the broker row is gone between the list and the prepare", async () => {
    queue = [];
    const { prepare } = await harness(spyVerdicter().verdicter);

    expect(await prepare()).toMatchObject({ ok: true, data: { status: "no-action", reason: APPROVE_AT_SESSION } });
  });
});

describe("inbox approve-chat act", () => {
  it("posts the owner's verdict exactly once and answers a replay of the same confirm without calling the broker", async () => {
    const spy = spyVerdicter();
    const { log, calls } = spyLog();
    const { prepare, act } = await harness(spy.verdicter, log);
    const { confirm } = ready(await prepare());

    const first = await act(confirm, { verdict: "deny" });
    const replay = await act(confirm, { verdict: "deny" });

    expect(first.envelope).toMatchObject({ ok: true, data: { outcome: { status: "answered" }, message: "Denied" } });
    expect(replay.envelope).toMatchObject({ ok: true, data: { outcome: { status: "already" } } });
    expect(spy.calls).toEqual([["permission", MSG, "deny"]]);
    expect(JSON.parse(await readFile(path.join(actionsDir(), `${confirm}.json`), "utf8"))).toMatchObject({ action: { kind: "approve-chat", msgId: MSG }, verdict: "deny" });
    expect(calls).toHaveLength(1);
    expect(calls[0]![1]).toMatchObject({ text: "deny" });
  });

  it("refuses a retry that changes the verdict after the first tap found the broker unreachable, posting nothing", async () => {
    const spy = spyVerdicter({ status: "unreachable", detail: "connect ECONNREFUSED" });
    const { prepare, act } = await harness(spy.verdicter);
    const { confirm } = ready(await prepare());

    const first = await act(confirm, { verdict: "allow" });
    const changed = await act(confirm, { verdict: "deny" });
    const bare = await act(confirm, {});
    const same = await act(confirm, { verdict: "allow" });

    expect(first.envelope).toMatchObject({ ok: true, data: { outcome: { status: "unreachable" } } });
    expect(changed.exitCode).toBe(EXIT.DATAERR);
    expect(changed.envelope).toMatchObject({ ok: false, error: expect.stringMatching(/already recorded allow/) });
    expect(bare.envelope.ok).toBe(false);
    expect(same.envelope).toMatchObject({ ok: true, data: { outcome: { status: "unreachable" } } });
    expect(spy.calls).toEqual([
      ["permission", MSG, "allow"],
      ["permission", MSG, "allow"],
    ]);
  });

  it("endorses with the read-back's stored text and recipient byte for byte, never the item's summary", async () => {
    const stored = "ship it \u{1F680}  \n";
    queue = [endorseRow(stored)];
    const spy = spyVerdicter();
    const { prepare, act } = await harness(spy.verdicter);
    const prepared = ready(await prepare());

    await act(prepared.confirm, { verdict: "endorse" });

    expect(prepared.readBack).toMatchObject({ text: stored });
    expect(spy.calls).toEqual([["endorse", MSG, stored, "agent-2"]]);
  });

  it("refuses a confirm read before the broker row's text changed, without calling the broker", async () => {
    const spy = spyVerdicter();
    const { prepare, act } = await harness(spy.verdicter);
    const { confirm } = ready(await prepare());
    queue = [{ ...permissionRow(), text: "Bash: another example command" }];

    const { envelope, exitCode } = await act(confirm);

    expect(exitCode).toBe(EXIT.DATAERR);
    expect(envelope).toMatchObject({ ok: false, error: expect.stringMatching(/changed since it was read/) });
    expect(spy.calls).toEqual([]);
    expect(await records()).toEqual([]);
  });

  it.each([
    ["loopback", null],
    ["a bearer", BEARER],
  ])("refuses %s with 403 and calls no broker route", async (_name, auth) => {
    const spy = spyVerdicter();
    const { prepare, act } = await harness(spy.verdicter);
    const { confirm } = ready(await prepare());

    const { exitCode } = await act(confirm, { verdict: "allow" }, context(auth));

    expect(exitCode).toBe(EXIT.NOPERM);
    expect(spy.calls).toEqual([]);
    expect(await records()).toEqual([]);
  });

  it.each([
    ["an endorse verdict on a permission prompt", { verdict: "endorse" }],
    ["no verdict", {}],
    ["free text", { verdict: "allow", text: "allow, and more" }],
  ])("refuses %s without calling the broker", async (_name, tap) => {
    const spy = spyVerdicter();
    const { prepare, act } = await harness(spy.verdicter);
    const { confirm } = ready(await prepare());

    const { envelope } = await act(confirm, tap);

    expect(envelope.ok).toBe(false);
    expect(spy.calls).toEqual([]);
  });

  it("reads a broker without the verdict routes (404) as refused naming the terminal command, and never shows the token", async () => {
    const tokenPath = path.join(dir, "ui.token");
    await writeFile(tokenPath, `${TOKEN}\n`);
    await chmod(tokenPath, 0o600);
    const echoing = (async () => new Response(JSON.stringify({ error: `no route; saw ${TOKEN}` }), { status: 404 })) as typeof fetch;
    const { prepare, act } = await harness(brokerVerdicter({ port: 1, tokenPath, fetch: echoing }));
    const preparedEnvelope = await prepare();

    const { envelope } = await act(ready(preparedEnvelope).confirm);

    expect(envelope).toMatchObject({ ok: true, data: { outcome: { status: "refused" }, message: expect.stringContaining(`agent-chat approve ${MSG} allow|deny`) } });
    expect(JSON.stringify([preparedEnvelope, envelope])).not.toContain(TOKEN);
  });
});
