import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OwnerItem } from "@titan-design/owner-queue";
import { invokeCommand } from "@titan-design/registry";
import { z } from "zod";
import type { BrokerAnswerer } from "./broker-answer.js";
import { factoryNeeds } from "./factory.js";
import { inboxActionCommands } from "./inbox-actions.js";
import type { ConsoleContext } from "./owner-guard.js";
import { shepherdReader } from "./shepherd.js";
import { startFakeDaemon, type FakeDaemon } from "./test-support.js";

const MSG = "msg-0007";
const CHAT_ID = `chat:${MSG}`;
const PREAMBLE = `[Owner answer from the console inbox to chat msg ${MSG}. A chat reply is not a resolution: record the outcome durably on this item (task note, PR comment or reply) before moving on.]\n\n`;
const OWNER_TEXT = "beta, and keep `[alpha]` as the alias";

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

async function commandsWith(answerer: BrokerAnswerer) {
  factory = await startFakeDaemon({ ok: true }, (command) => {
    if (command === "needs.list") return { items: [chatAsk()], gaps: [] };
    if (command === "shepherd.list") return [];
    throw new Error(`no fixture for ${command}`);
  });
  const sources = { factory: factoryNeeds(factory.port), shepherd: shepherdReader(factory.port), rounds: { dir: path.join(dir, "rounds") }, inbox: { dir: path.join(dir, "deposits") } };
  const client = { post: () => Promise.reject(new Error("an answer-chat tap never posts to the factory")) };
  return inboxActionCommands(sources, { enabled: true, actionsDir: path.join(dir, "owner-actions"), client, now: () => Date.parse("2026-10-10T06:00:00.000Z"), answerer });
}

const confirmOf = z.object({ ok: z.literal(true), data: z.object({ status: z.literal("ready"), confirm: z.string() }) });

describe("inbox answer-chat", () => {
  it("sends the owner's text behind the fixed outcome preamble naming the chat msg, keeping the owner's words unchanged", async () => {
    const answers: [string, string][] = [];
    const commands = await commandsWith({
      answer: async (msgId, text) => {
        answers.push([msgId, text]);
        return { status: "answered" };
      },
    });
    const { confirm } = confirmOf.parse((await invokeCommand(commands["inbox.prepare"], { itemId: CHAT_ID }, OWNER)).envelope).data;

    await invokeCommand(commands["inbox.act"], { itemId: CHAT_ID, confirm, text: OWNER_TEXT }, OWNER);

    expect(answers).toEqual([[MSG, `${PREAMBLE}${OWNER_TEXT}`]]);
    expect(answers[0]![1]).toContain(`chat msg ${MSG}`);
    expect(JSON.parse(await readFile(path.join(dir, "owner-actions", `${confirm}.json`), "utf8"))).toMatchObject({ text: OWNER_TEXT });
  });
});
