import { describe, expect, it } from "vitest";
import type { TelegramConfig } from "./telegram.js";
import { TelegramTransport } from "./telegram.js";
import { answerCallbackQuery } from "./telegram-updates.js";

const TOKEN = "123456789:AAH-fake-bot-token_for-tests";

function tooManyRequests(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ ok: false, error_code: 429, ...body }), {
    status: 429,
    headers: { "content-type": "application/json" },
  });
}

function configWith(response: () => Response): TelegramConfig {
  return { token: TOKEN, chatIdFor: () => 4242, fetch: async () => response() };
}

async function sendInto(response: () => Response) {
  return await new TelegramTransport(configWith(response)).send({
    handle: "lifter",
    text: "sunday?",
  });
}

describe("a 429 from the Bot API", () => {
  it("a 429 with parameters.retry_after is rate-limited with those seconds", async () => {
    const result = await sendInto(() =>
      tooManyRequests({
        description: "Too Many Requests: retry after 99",
        parameters: { retry_after: 12 },
      }),
    );

    expect(result).toEqual({
      ok: false,
      error: {
        kind: "rate-limited",
        retryAfterSeconds: 12,
        message: "Too Many Requests: retry after 99",
      },
    });
  });

  it("a 429 with only a description falls back to the description", async () => {
    const result = await sendInto(() =>
      tooManyRequests({ description: "Too Many Requests: retry after 7" }),
    );

    expect(result).toEqual({
      ok: false,
      error: {
        kind: "rate-limited",
        retryAfterSeconds: 7,
        message: "Too Many Requests: retry after 7",
      },
    });
  });

  it("a 429 with neither carries no seconds", async () => {
    const result = await sendInto(() => tooManyRequests({ description: "Too Many Requests" }));

    expect(result).toEqual({
      ok: false,
      error: { kind: "rate-limited", message: "Too Many Requests" },
    });
  });

  it("a 429 on answerCallbackQuery is rate-limited too", async () => {
    const result = await answerCallbackQuery(
      configWith(() =>
        tooManyRequests({
          description: "Too Many Requests: retry after 3",
          parameters: { retry_after: 3 },
        }),
      ),
      "cbq-9",
    );

    expect(result).toEqual({
      ok: false,
      reason: "answerCallbackQuery failed: Too Many Requests: retry after 3",
      error: {
        kind: "rate-limited",
        retryAfterSeconds: 3,
        message: "Too Many Requests: retry after 3",
      },
    });
  });

  it("no rate-limited message contains the token", async () => {
    const results = [
      await sendInto(() =>
        tooManyRequests({ description: `Too Many Requests for bot${TOKEN}: retry after 5` }),
      ),
      await answerCallbackQuery(
        configWith(() =>
          tooManyRequests({ description: `Too Many Requests ${encodeURIComponent(TOKEN)}` }),
        ),
        "cbq-9",
      ),
    ];

    for (const result of results) {
      expect(JSON.stringify(result)).not.toContain(TOKEN);
      expect(JSON.stringify(result)).toContain("***");
    }
  });

  it("reads retry_after even when the description names no wait", async () => {
    const result = await sendInto(() =>
      tooManyRequests({ description: "Too Many Requests", parameters: { retry_after: 30 } }),
    );

    expect(result).toEqual({
      ok: false,
      error: { kind: "rate-limited", retryAfterSeconds: 30, message: "Too Many Requests" },
    });
  });
});
