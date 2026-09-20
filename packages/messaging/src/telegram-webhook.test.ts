import { describe, expect, it } from "vitest";
import type { SeenStore } from "./inbound.js";
import { MemorySeenStore } from "./inbound.js";
import type { ValidateTelegramWebhookInput } from "./telegram-webhook.js";
import { validateTelegramWebhook } from "./telegram-webhook.js";

const SECRET = "webhook-secret-abcdef";
const CHAT = 4242;

/** An Update as the Bot API documents it, trimmed to the fields read here. */
const UPDATE = {
  update_id: 870123456,
  message: {
    message_id: 1414,
    from: {
      id: 99,
      is_bot: false,
      first_name: "Lifter",
      language_code: "en",
    },
    chat: { id: CHAT, first_name: "Lifter", type: "private" },
    date: 1757808000,
    text: "ready for sunday",
  },
};

function input(
  overrides: Partial<ValidateTelegramWebhookInput> = {},
): ValidateTelegramWebhookInput {
  return {
    headerSecret: SECRET,
    expectedSecret: SECRET,
    allowedChatIds: [CHAT],
    body: UPDATE,
    maxTextLength: 2000,
    seen: new MemorySeenStore(),
    ...overrides,
  };
}

function callbackWith(query: Record<string, unknown>): unknown {
  return {
    update_id: 870123457,
    callback_query: {
      id: "cbq-1",
      from: { id: 99, is_bot: false, first_name: "Lifter" },
      message: { message_id: 1415, date: 1757808060, chat: { id: CHAT } },
      chat_instance: "-123",
      data: "v1|ate|lunch|2026-09-18",
      ...query,
    },
  };
}

function updateWith(message: Record<string, unknown> | undefined): unknown {
  return { update_id: UPDATE.update_id, message };
}

describe("validateTelegramWebhook", () => {
  it("accepts a text message from an allowed chat", async () => {
    const result = await validateTelegramWebhook(input());

    expect(result).toEqual({
      status: "accepted",
      kind: "text",
      updateId: 870123456,
      chatId: CHAT,
      fromId: 99,
      messageId: 1414,
      text: "ready for sunday",
      date: 1757808000,
    });
  });

  it("rejects a header secret that is one character off", async () => {
    const result = await validateTelegramWebhook(
      input({ headerSecret: "webhook-secret-abcdee" }),
    );

    expect(result).toEqual({ status: "rejected", reason: "bad-secret" });
  });

  it("rejects a wrong secret before looking at the body", async () => {
    const result = await validateTelegramWebhook(
      input({ headerSecret: "wrong", body: { nonsense: true } }),
    );

    expect(result).toEqual({ status: "rejected", reason: "bad-secret" });
  });

  it("rejects an empty expected secret", async () => {
    const result = await validateTelegramWebhook(
      input({ headerSecret: "", expectedSecret: "" }),
    );

    expect(result).toEqual({ status: "rejected", reason: "bad-secret" });
  });

  it("rejects a chat outside the allowlist", async () => {
    const result = await validateTelegramWebhook(
      input({
        body: updateWith({ ...UPDATE.message, chat: { id: 9999, type: "private" } }),
      }),
    );

    expect(result).toEqual({ status: "rejected", reason: "sender-not-allowed" });
  });

  it("rejects text over the length cap", async () => {
    const result = await validateTelegramWebhook(
      input({ body: updateWith({ ...UPDATE.message, text: "x".repeat(2001) }) }),
    );

    expect(result).toEqual({ status: "rejected", reason: "too-long" });
  });

  it("rejects an update that is not a text message", async () => {
    const noMessage = await validateTelegramWebhook(
      input({ body: { update_id: 1, edited_message: UPDATE.message } }),
    );
    const noText = await validateTelegramWebhook(
      input({ body: updateWith({ message_id: 1, date: 1, chat: { id: CHAT }, from: { id: 99 } }) }),
    );
    const noSender = await validateTelegramWebhook(
      input({ body: updateWith({ message_id: 1, date: 1, chat: { id: CHAT }, text: "hi" }) }),
    );

    for (const result of [noMessage, noText, noSender]) {
      expect(result).toEqual({ status: "rejected", reason: "not-text" });
    }
  });

  it("rejects a payload that is not an Update", async () => {
    const garbage = await validateTelegramWebhook(input({ body: "not json at all" }));
    const noId = await validateTelegramWebhook(input({ body: { message: UPDATE.message } }));
    const badChat = await validateTelegramWebhook(
      input({ body: updateWith({ date: 1, text: "hi", chat: { id: "4242" } }) }),
    );

    for (const result of [garbage, noId, badChat]) {
      expect(result).toEqual({ status: "rejected", reason: "malformed" });
    }
  });

  it("accepts an update_id once and rejects the replay", async () => {
    const seen = new MemorySeenStore();

    const first = await validateTelegramWebhook(input({ seen }));
    const second = await validateTelegramWebhook(input({ seen }));

    expect(first.status).toBe("accepted");
    expect(second).toEqual({ status: "rejected", reason: "duplicate" });
  });

  it("awaits an async SeenStore", async () => {
    const ids = new Set<string>();
    const seen: SeenStore = {
      has: async (id) => ids.has(id),
      add: async (id) => {
        ids.add(id);
      },
    };

    expect((await validateTelegramWebhook(input({ seen }))).status).toBe("accepted");
    expect(await validateTelegramWebhook(input({ seen }))).toEqual({
      status: "rejected",
      reason: "duplicate",
    });
  });

  it("does not record an update_id it rejected", async () => {
    const seen = new MemorySeenStore();

    await validateTelegramWebhook(
      input({ seen, body: updateWith({ ...UPDATE.message, chat: { id: 9999 } }) }),
    );

    expect(seen.has(String(UPDATE.update_id))).toBe(false);
  });
});

describe("validateTelegramWebhook with button taps", () => {
  it("accepts a tap from an allowed chat with every field", async () => {
    const result = await validateTelegramWebhook(input({ body: callbackWith({}) }));

    expect(result).toEqual({
      status: "accepted",
      kind: "callback",
      updateId: 870123457,
      chatId: CHAT,
      fromId: 99,
      callbackQueryId: "cbq-1",
      messageId: 1415,
      data: "v1|ate|lunch|2026-09-18",
      date: 1757808060,
    });
  });

  it("rejects a tap from a chat outside the allowlist", async () => {
    const result = await validateTelegramWebhook(
      input({
        body: callbackWith({
          message: { message_id: 1, date: 1, chat: { id: 9999 } },
        }),
      }),
    );

    expect(result).toEqual({ status: "rejected", reason: "sender-not-allowed" });
  });

  it("rejects a tap with no data or no message as unreadable", async () => {
    const noData = await validateTelegramWebhook(
      input({ body: callbackWith({ data: undefined }) }),
    );
    const noMessage = await validateTelegramWebhook(
      input({ body: callbackWith({ message: undefined }) }),
    );

    for (const result of [noData, noMessage]) {
      expect(result).toEqual({ status: "rejected", reason: "not-text" });
    }
  });

  it("accepts a tap once and rejects the replay", async () => {
    const seen = new MemorySeenStore();

    const first = await validateTelegramWebhook(input({ seen, body: callbackWith({}) }));
    const second = await validateTelegramWebhook(input({ seen, body: callbackWith({}) }));

    expect(first.status).toBe("accepted");
    expect(second).toEqual({ status: "rejected", reason: "duplicate" });
  });
});
