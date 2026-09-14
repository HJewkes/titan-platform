import { describe, expect, it } from "vitest";
import type { TelegramConfig } from "./telegram.js";
import { probeTelegramLiveness } from "./telegram-liveness.js";

const TOKEN = "123456789:AAH-fake-bot-token_for-tests";

function config(doFetch: typeof fetch): TelegramConfig {
  return { token: TOKEN, chatIdFor: () => undefined, fetch: doFetch };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("probeTelegramLiveness", () => {
  it("reports alive with the bot identity from getMe", async () => {
    let requested = "";
    const result = await probeTelegramLiveness(
      config(async (url) => {
        requested = String(url);
        return json({
          ok: true,
          result: {
            id: 123456789,
            is_bot: true,
            first_name: "Coach",
            username: "titan_coach_bot",
            can_join_groups: true,
          },
        });
      }),
      { timeoutMs: 1000 },
    );

    expect(result).toEqual({
      state: "alive",
      username: "titan_coach_bot",
      botId: 123456789,
    });
    expect(requested).toBe(`https://api.telegram.org/bot${TOKEN}/getMe`);
  });

  it("reports dark/unreachable when the connection fails", async () => {
    const result = await probeTelegramLiveness(
      config(async () => {
        throw new TypeError("fetch failed");
      }),
      { timeoutMs: 1000 },
    );

    expect(result).toEqual({ state: "dark", reason: "unreachable" });
  });

  it("reports dark/timeout and aborts the request it gave up on", async () => {
    let signal: AbortSignal | undefined;
    const result = await probeTelegramLiveness(
      config((_url, init) => {
        signal = init?.signal ?? undefined;
        return new Promise<Response>(() => {});
      }),
      { timeoutMs: 10 },
    );

    expect(result).toEqual({ state: "dark", reason: "timeout" });
    expect(signal?.aborted).toBe(true);
  });

  it("reports dark/unauthorized on a revoked token", async () => {
    const result = await probeTelegramLiveness(
      config(async () =>
        json({ ok: false, error_code: 401, description: "Unauthorized" }, 401),
      ),
      { timeoutMs: 1000 },
    );

    expect(result).toEqual({ state: "dark", reason: "unauthorized" });
  });

  it("reports dark/bad-response for a 500, an ok:false body and a non-json body", async () => {
    const serverError = await probeTelegramLiveness(
      config(async () => json({ ok: false }, 500)),
      { timeoutMs: 1000 },
    );
    const notOk = await probeTelegramLiveness(
      config(async () => json({ ok: false, description: "Bad Request" })),
      { timeoutMs: 1000 },
    );
    const notJson = await probeTelegramLiveness(
      config(async () => new Response("<html>proxy</html>")),
      { timeoutMs: 1000 },
    );

    for (const result of [serverError, notOk, notJson]) {
      expect(result).toEqual({ state: "dark", reason: "bad-response" });
    }
  });
});
