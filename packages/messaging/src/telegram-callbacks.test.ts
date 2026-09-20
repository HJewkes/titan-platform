import { describe, expect, it } from "vitest";
import type { TelegramConfig } from "./telegram.js";
import type { TelegramInbound } from "./telegram-updates.js";
import { answerCallbackQuery, pollUpdates } from "./telegram-updates.js";

const TOKEN = "123456789:AAH-fake-bot-token_for-tests";
const CHAT = 4242;
const DATA = "v1|ate|lunch|2026-09-18";

function callbackUpdate(
  updateId: number,
  overrides: Record<string, unknown> = {},
  chatId = CHAT,
): unknown {
  return {
    update_id: updateId,
    callback_query: {
      id: `cbq-${updateId}`,
      from: { id: 99, is_bot: false, first_name: "Lifter" },
      message: { message_id: 555, date: 1757808000, chat: { id: chatId, type: "private" } },
      chat_instance: "-123",
      data: DATA,
      ...overrides,
    },
  };
}

function textUpdate(updateId: number, text: string): unknown {
  return {
    update_id: updateId,
    message: { message_id: updateId * 10, date: 1757808000, text, from: { id: 99 }, chat: { id: CHAT } },
  };
}

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Answers one poll with `batch`, then blocks so the collector stops on count. */
function configFor(batch: unknown[]): TelegramConfig {
  let answered = false;
  return {
    token: TOKEN,
    chatIdFor: () => CHAT,
    fetch: async () => {
      if (answered) return await new Promise<Response>(() => {});
      answered = true;
      return reply({ ok: true, result: batch });
    },
  };
}

async function firstYields(batch: unknown[], count: number): Promise<TelegramInbound[]> {
  const seen: TelegramInbound[] = [];
  const iterator = pollUpdates(configFor(batch), {
    timeoutSeconds: 1,
    allowedChatIds: [CHAT],
  });
  for await (const update of iterator) {
    seen.push(update);
    if (seen.length === count) break;
  }
  return seen;
}

describe("pollUpdates with callback queries", () => {
  it("yields a button tap with every field", async () => {
    const [update] = await firstYields([callbackUpdate(301)], 1);

    expect(update).toEqual({
      kind: "callback",
      updateId: 301,
      chatId: CHAT,
      fromId: 99,
      callbackQueryId: "cbq-301",
      messageId: 555,
      data: DATA,
      date: 1757808000,
    });
  });

  it("drops a tap from a chat that is not on the allowlist", async () => {
    const updates = await firstYields(
      [callbackUpdate(401, {}, 9999), textUpdate(402, "mine")],
      1,
    );

    expect(updates.map((update) => update.updateId)).toEqual([402]);
  });

  it("skips a tap with no data or no message, and still yields text", async () => {
    const withoutData = callbackUpdate(501, { data: undefined });
    const withoutMessage = callbackUpdate(502, { message: undefined });

    const updates = await firstYields(
      [withoutData, withoutMessage, textUpdate(503, "ready"), callbackUpdate(504)],
      2,
    );

    expect(updates.map((update) => [update.kind, update.updateId])).toEqual([
      ["text", 503],
      ["callback", 504],
    ]);
  });
});

describe("answerCallbackQuery", () => {
  it("posts the callback id and toast text and reports ok", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const result = await answerCallbackQuery(
      {
        token: TOKEN,
        chatIdFor: () => CHAT,
        fetch: async (url, init) => {
          calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
          return reply({ ok: true, result: true });
        },
      },
      "cbq-9",
      "Logged",
    );

    expect(result).toEqual({ ok: true });
    expect(calls).toEqual([
      {
        url: `https://api.telegram.org/bot${TOKEN}/answerCallbackQuery`,
        body: { callback_query_id: "cbq-9", text: "Logged" },
      },
    ]);
  });

  it("keeps the token out of an API rejection", async () => {
    const result = await answerCallbackQuery(
      {
        token: TOKEN,
        chatIdFor: () => CHAT,
        fetch: async () =>
          reply({ ok: false, description: `Bad Request: query is too old ${TOKEN}` }, 400),
      },
      "cbq-9",
    );

    expect(result).toEqual({
      ok: false,
      reason: "answerCallbackQuery failed: Bad Request: query is too old ***",
      error: {
        kind: "rejected",
        status: 400,
        message: "Bad Request: query is too old ***",
      },
    });
  });

  it("keeps the token out of a fetch error that embeds the whole url", async () => {
    const url = `https://api.telegram.org/bot${TOKEN}/answerCallbackQuery`;
    const result = await answerCallbackQuery(
      {
        token: TOKEN,
        chatIdFor: () => CHAT,
        fetch: async () => {
          throw new TypeError(`request to ${url} failed, reason: ECONNREFUSED`);
        },
      },
      "cbq-9",
    );

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).toContain("***");
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });
});
