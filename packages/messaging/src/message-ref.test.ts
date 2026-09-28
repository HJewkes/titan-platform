import { describe, expect, it } from "vitest";
import { TelegramTransport } from "./telegram.js";
import { readInbound, refOfInbound } from "./telegram-updates.js";

const TOKEN = "123456789:AAH-fake-bot-token_for-tests";
const CHAT = 4242;
const DATA = "v1|ate|lunch|2026-09-18";

function reply(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function textUpdate(overrides: Record<string, unknown> = {}): unknown {
  return {
    update_id: 1,
    message: {
      message_id: 808,
      date: 1757808000,
      text: "ate it",
      from: { id: 99 },
      chat: { id: CHAT },
      ...overrides,
    },
  };
}

function tapUpdate(message: Record<string, unknown> = {}): unknown {
  return {
    update_id: 2,
    callback_query: {
      id: "cbq-2",
      from: { id: 99 },
      data: DATA,
      message: {
        message_id: 555,
        date: 1757808000,
        chat: { id: CHAT },
        ...message,
      },
    },
  };
}

function inboundOf(raw: unknown) {
  const read = readInbound(raw);
  if (!read.ok) throw new Error(`expected a readable update, got ${read.reason}`);
  return read.inbound;
}

describe("message identity", () => {
  it("a send returns a ref holding the resolved chat and message id", async () => {
    const transport = new TelegramTransport({
      token: TOKEN,
      chatIdFor: () => CHAT,
      fetch: async () => reply({ ok: true, result: { message_id: 77, date: 1 } }),
    });

    const result = await transport.send({ handle: "lifter", text: "sunday?" });

    expect(result).toEqual({
      ok: true,
      messageGuid: "77",
      ref: { channel: "telegram", chat: "4242", messageId: "77" },
    });
  });

  it("a 2xx with an unreadable message id is ok with no ref", async () => {
    const transport = new TelegramTransport({
      token: TOKEN,
      chatIdFor: () => CHAT,
      fetch: async () => reply({ ok: true, result: {} }),
    });

    expect(await transport.send({ handle: "lifter", text: "hi" })).toEqual({ ok: true });
  });

  it("a typed update carries its message id", () => {
    const inbound = inboundOf(
      textUpdate({ message_thread_id: 12, reply_to_message: { message_id: 800 } }),
    );

    expect(inbound).toMatchObject({
      kind: "text",
      messageId: 808,
      threadId: 12,
      replyToMessageId: 800,
    });
    expect(refOfInbound(inbound)).toEqual({
      channel: "telegram",
      chat: "4242",
      messageId: "808",
      threadId: "12",
    });
  });

  it("a tap carries the prompt's buttons", () => {
    const inbound = inboundOf(
      tapUpdate({
        text: "Lunch?",
        reply_markup: {
          inline_keyboard: [
            [
              { text: "Ate", callback_data: DATA },
              { text: "Skipped", callback_data: "v1|skip|lunch|2026-09-18" },
            ],
          ],
        },
      }),
    );

    expect(inbound).toMatchObject({
      kind: "callback",
      messageId: 555,
      messageText: "Lunch?",
      buttons: [
        [
          { label: "Ate", data: DATA },
          { label: "Skipped", data: "v1|skip|lunch|2026-09-18" },
        ],
      ],
    });
    expect(refOfInbound(inbound)).toEqual({
      channel: "telegram",
      chat: "4242",
      messageId: "555",
    });
  });

  it("a tap whose keyboard holds a URL button keeps only the callback buttons", () => {
    const inbound = inboundOf(
      tapUpdate({
        reply_markup: {
          inline_keyboard: [
            [{ text: "Ate", callback_data: DATA }, { text: "Open", url: "https://example.test" }],
            [{ text: "Docs", url: "https://example.test/docs" }],
          ],
        },
      }),
    );

    expect(inbound).toMatchObject({ buttons: [[{ label: "Ate", data: DATA }]] });
  });

  it("a tap on a prompt with no keyboard carries no buttons", () => {
    expect(inboundOf(tapUpdate())).not.toHaveProperty("buttons");
  });
});
