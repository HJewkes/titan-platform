import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  InteractiveTransport,
  MessageRef,
  MessageTransport,
  SendResult,
} from "./contract.js";
import { BlueBubblesTransport } from "./bluebubbles.js";
import type { TelegramConfig } from "./telegram.js";
import { TelegramTransport } from "./telegram.js";

const TOKEN = "123456789:AAH-fake-bot-token_for-tests";
const REF: MessageRef = { channel: "telegram", chat: "4242", messageId: "555" };

interface Recorder {
  transport: TelegramTransport;
  calls: Array<{ method: string; body: Record<string, unknown> }>;
}

function recording(
  respond: () => Response = () => new Response(JSON.stringify({ ok: true, result: true })),
  overrides: Partial<TelegramConfig> = {},
): Recorder {
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  const transport = new TelegramTransport({
    token: TOKEN,
    chatIdFor: () => 4242,
    fetch: async (url, init) => {
      calls.push({
        method: String(url).split("/").pop() ?? "",
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return respond();
    },
    ...overrides,
  });
  return { transport, calls };
}

function badRequest(description: string): Response {
  return new Response(JSON.stringify({ ok: false, error_code: 400, description }), {
    status: 400,
    headers: { "content-type": "application/json" },
  });
}

function blueBubbles(onFetch: () => void): BlueBubblesTransport {
  return new BlueBubblesTransport({
    baseUrl: "http://127.0.0.1:1234",
    password: "hunter2-secret",
    chatGuidFor: () => "iMessage;-;+15550000000",
    fetch: async () => {
      onFetch();
      return new Response("{}");
    },
  });
}

describe("Telegram interactions", () => {
  it("a reaction posts setMessageReaction for the ref's chat and message", async () => {
    const { transport, calls } = recording();

    const result = await transport.react({ to: REF, emoji: "👀" });

    expect(result).toEqual({ ok: true, changed: true });
    expect(calls).toEqual([
      {
        method: "setMessageReaction",
        body: { chat_id: "4242", message_id: 555, reaction: [{ type: "emoji", emoji: "👀" }] },
      },
    ]);
  });

  it("a null emoji clears the reaction", async () => {
    const { transport, calls } = recording();

    await transport.react({ to: REF, emoji: null });

    expect(calls[0]?.body).toEqual({ chat_id: "4242", message_id: 555, reaction: [] });
  });

  it("an edit without text calls editMessageReplyMarkup", async () => {
    const { transport, calls } = recording();

    await transport.edit({ ref: REF, buttons: "remove" });
    await transport.edit({ ref: REF, text: "Logged" });

    expect(calls.map((call) => call.method)).toEqual([
      "editMessageReplyMarkup",
      "editMessageText",
    ]);
    expect(calls[0]?.body).toEqual({
      chat_id: "4242",
      message_id: 555,
      reply_markup: { inline_keyboard: [] },
    });
  });

  it("an edit with neither text nor buttons is rejected and makes no request", async () => {
    const { transport, calls } = recording();

    const result = await transport.edit({ ref: REF });

    expect(result).toEqual({
      ok: false,
      error: {
        kind: "bad-buttons",
        message: "An edit needs text or buttons to change; this one had neither",
      },
    });
    expect(calls).toEqual([]);
  });

  it("an unchanged edit is ok and unchanged", async () => {
    const { transport } = recording(() =>
      badRequest("Bad Request: message is not modified"),
    );

    expect(await transport.edit({ ref: REF, text: "same" })).toEqual({
      ok: true,
      changed: false,
    });
  });

  it("an edit of a deleted message is message-gone", async () => {
    const { transport } = recording(() =>
      badRequest("Bad Request: message to edit not found"),
    );

    expect(await transport.edit({ ref: REF, text: "gone" })).toEqual({
      ok: false,
      error: { kind: "message-gone", message: "Bad Request: message to edit not found" },
    });
  });

  it("a chat action resolves the handle and answers a callback by id", async () => {
    const { transport, calls } = recording();

    await transport.chatAction({ handle: "lifter", action: "typing" });
    await transport.answerAction({ actionId: "cbq-9", toast: "Logged" });

    expect(calls).toEqual([
      { method: "sendChatAction", body: { chat_id: 4242, action: "typing" } },
      { method: "answerCallbackQuery", body: { callback_query_id: "cbq-9", text: "Logged" } },
    ]);
  });

  it("reports what it can do, with button states off until spike S5", () => {
    const { transport } = recording();

    expect(transport.capabilities).toEqual({
      channel: "telegram",
      maxTextLength: 4096,
      canInitiate: false,
      deliveryCeiling: "accepted",
      buttons: true,
      buttonStates: false,
      edits: true,
      reactions: true,
      chatActions: true,
      drafts: false,
      draftStreaming: false,
      threads: false,
    });
  });

  it("drops button state and style until buttonStates is on", async () => {
    const plain = recording();
    const styled = recording(undefined, { buttonStates: true });
    const buttons = [[{ label: "Ate", data: "v1|ate", state: "disabled" as const, style: "success" as const }]];

    await plain.transport.edit({ ref: REF, buttons });
    await styled.transport.edit({ ref: REF, buttons });

    expect(plain.calls[0]?.body.reply_markup).toEqual({
      inline_keyboard: [[{ text: "Ate", callback_data: "v1|ate" }]],
    });
    expect(styled.calls[0]?.body.reply_markup).toEqual({
      inline_keyboard: [[{ text: "Ate", callback_data: "v1|ate", style: "success", disabled: {} }]],
    });
  });
});

describe("BlueBubbles interactions", () => {
  it("BlueBubbles answers unsupported and makes no request", async () => {
    let requests = 0;
    const transport = blueBubbles(() => (requests += 1));

    const results = [
      await transport.react(),
      await transport.chatAction(),
      await transport.edit(),
      await transport.answerAction(),
    ];

    expect(results.map((result) => !result.ok && result.error)).toEqual([
      { kind: "unsupported", capability: "reactions", message: expect.any(String) },
      { kind: "unsupported", capability: "chatActions", message: expect.any(String) },
      { kind: "unsupported", capability: "edits", message: expect.any(String) },
      { kind: "unsupported", capability: "buttons", message: expect.any(String) },
    ]);
    expect(requests).toBe(0);
    expect(transport.capabilities.channel).toBe("imessage");
  });
});

/** A fake as 0.3.0 consumers wrote them: one method, no capabilities, no ref. */
class LegacyFake implements MessageTransport {
  async send(): Promise<SendResult> {
    return { ok: true, messageGuid: "fake-1" };
  }
}

describe("contract compatibility", () => {
  it("MessageTransport fakes written for 0.3.0 still compile", async () => {
    const transport: MessageTransport = new LegacyFake();

    expectTypeOf<LegacyFake>().toExtend<MessageTransport>();
    expectTypeOf<InteractiveTransport>().toExtend<MessageTransport>();
    expectTypeOf<LegacyFake>().not.toExtend<InteractiveTransport>();
    expect(await transport.send({ handle: "lifter", text: "hi" })).toEqual({
      ok: true,
      messageGuid: "fake-1",
    });
  });
});
