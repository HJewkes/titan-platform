import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OwnerItem } from "@titan-design/owner-queue";
import { invokeCommand } from "@titan-design/registry";
import { z } from "zod";
import type { AnswerOutcome, BrokerAnswerer } from "./broker-answer.js";
import type { DecisionLog } from "./decision-log.js";
import { factoryNeeds } from "./factory.js";
import { inboxActionCommands } from "./inbox-actions.js";
import type { OwnerActionClient } from "./owner-action.js";
import type { ConsoleContext } from "./owner-guard.js";
import { shepherdReader } from "./shepherd.js";
import { startFakeDaemon, type FakeDaemon } from "./test-support.js";

const MSG = "msg-0007";
const CHAT_ID = `chat:${MSG}`;
const PREAMBLE = `[Owner answer from the console inbox to chat msg ${MSG}. A chat reply is not a resolution: record the outcome durably on this item (task note, PR comment or reply) before moving on.]\n\n`;

const OWNER: ConsoleContext = { warnings: [], format: "json", surface: "http", auth: { credential: "session", issuedAt: 1_000, peerLocal: false }, ownerWrites: true };

let dir: string;
let factory: FakeDaemon | undefined;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "console-inbox-preamble-"));
});

afterEach(async () => {
  await factory?.close();
  factory = undefined;
  await rm(dir, { recursive: true, force: true });
});

function chatAsk(): OwnerItem {
  return {
    id: CHAT_ID,
    sources: [{ system: "agent-chat", ref: MSG }],
    kind: "decide",
    door: "two-way",
    summary: "Which fixture name should the parser use?",
    context: "Two names fit; pick one.",
    options: [
      { id: "a", label: "alpha" },
      { id: "b", label: "beta" },
    ],
    keys: [],
    asker: "test-asker",
    personal: false,
    lens: "blocking-agent",
    unblocks: [],
    openedAt: "2026-10-10T04:00:00.000Z",
    status: "open",
  };
}

/** The broker as the console sees it: the first answer to an open question lands, any later one finds it closed. */
function spyBroker(first: AnswerOutcome = { status: "answered" }) {
  const answers: [string, string][] = [];
  const answerer: BrokerAnswerer = {
    answer: async (msgId, text) => {
      answers.push([msgId, text]);
      return answers.length === 1 ? first : { status: "closed", reason: `${msgId} is not an open item` };
    },
  };
  return { answerer, answers };
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

const readyEnvelope = z.object({ ok: z.literal(true), data: z.object({ status: z.literal("ready"), confirm: z.string() }) });

async function harness(answerer: BrokerAnswerer, decisionLog?: DecisionLog) {
  factory = await startFakeDaemon({ ok: true }, (command) => {
    if (command === "needs.list") return { items: [chatAsk()], gaps: [] };
    if (command === "shepherd.list") return [];
    throw new Error(`no fixture for ${command}`);
  });
  const sources = { factory: factoryNeeds(factory.port), shepherd: shepherdReader(factory.port), rounds: { dir: path.join(dir, "rounds") }, inbox: { dir: path.join(dir, "deposits") } };
  const posts: string[] = [];
  const client: OwnerActionClient = {
    post: async (actionId) => {
      posts.push(actionId);
      return { status: "gone", reason: "an answer-chat tap never posts to the factory" };
    },
  };
  const commands = inboxActionCommands(sources, { enabled: true, actionsDir: actionsDir(), client, now: () => Date.parse("2026-10-10T06:00:00.000Z"), answerer, ...(decisionLog && { decisionLog }) });
  const { confirm } = readyEnvelope.parse((await invokeCommand(commands["inbox.prepare"], { itemId: CHAT_ID }, OWNER)).envelope).data;
  const act = (text: string) => invokeCommand(commands["inbox.act"], { itemId: CHAT_ID, confirm, text }, OWNER);
  return { confirm, act, posts };
}

const recordOf = async (confirm: string): Promise<unknown> => JSON.parse(await readFile(path.join(actionsDir(), `${confirm}.json`), "utf8"));

describe("inbox answer-chat", () => {
  it("sends the owner's text behind the fixed outcome preamble naming the chat msg, keeping the owner's words unchanged", async () => {
    const broker = spyBroker();
    const { confirm, act } = await harness(broker.answerer);

    await act("beta, and keep `[alpha]` as the alias");

    expect(broker.answers).toEqual([[MSG, `${PREAMBLE}beta, and keep \`[alpha]\` as the alias`]]);
    expect(broker.answers[0]![1]).toContain(`chat msg ${MSG}`);
    expect(await recordOf(confirm)).toMatchObject({ text: "beta, and keep `[alpha]` as the alias" });
  });

  it("sends the owner's text to the broker, keeps it in the record and logs it as the answer", async () => {
    const broker = spyBroker();
    const { log, calls } = spyLog();
    const { confirm, act, posts } = await harness(broker.answerer, log);

    const { envelope } = await act("  alpha  ");

    expect(envelope).toMatchObject({ ok: true, data: { outcome: { status: "answered" }, message: "Answer sent" } });
    expect(broker.answers).toEqual([[MSG, `${PREAMBLE}alpha`]]);
    expect(posts).toEqual([]);
    expect(await recordOf(confirm)).toMatchObject({ itemId: CHAT_ID, action: { kind: "answer-chat", msgId: MSG }, text: "alpha" });
    expect(calls).toHaveLength(1);
    expect(calls[0]![1]).toMatchObject({ text: "alpha", by: { class: "owner-remote", id: "titan-console", channel: "console:inbox" } });
  });

  it("leaves a broker-down answer unsettled, so the retry sends the words first written", async () => {
    const broker = spyBroker({ status: "unreachable", detail: "connect ECONNREFUSED" });
    const { confirm, act } = await harness(broker.answerer);

    const down = await act("alpha");
    const afterDown = await readdir(actionsDir());
    await act("beta");

    expect(down.envelope).toMatchObject({ ok: true, data: { outcome: { status: "unreachable" } } });
    expect(afterDown).toEqual([`${confirm}.json`]);
    expect(broker.answers).toEqual([
      [MSG, `${PREAMBLE}alpha`],
      [MSG, `${PREAMBLE}alpha`],
    ]);
  });
});
