import { describe, expect, it } from "vitest";
import type { TelegramConfig } from "./telegram.js";
import { redactToken, TelegramTransport } from "./telegram.js";

const TOKEN = "123456789:AAH-fake-bot-token_for-tests";
const SEND_URL = `https://api.telegram.org/bot${TOKEN}/sendMessage`;

function envelope(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** The shape Node's undici fetch throws: a bare TypeError with the coded socket error on `cause`. */
function undiciFailure(code: string): TypeError {
  const cause = Object.assign(new Error(`${code} from the socket`), { code });
  return new TypeError("fetch failed", { cause });
}

function unreadable(status: number): Response {
  return new Response("<html>gateway</html>", { status });
}

function transportWith(
  doFetch: typeof fetch,
  overrides: Partial<TelegramConfig> = {},
): TelegramTransport {
  return new TelegramTransport({
    token: TOKEN,
    chatIdFor: () => 4242,
    fetch: doFetch,
    ...overrides,
  });
}

describe("TelegramTransport.send", () => {
  it("posts sendMessage with chat_id and text and no parse_mode", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const transport = transportWith(async (url, init) => {
      calls.push({ url: String(url), init });
      return envelope({ ok: true, result: { message_id: 77, date: 1 } });
    });

    const result = await transport.send({ handle: "lifter", text: "sunday?" });

    expect(result).toEqual({ ok: true, messageGuid: "77" });
    const call = calls[0];
    expect(call?.url).toBe(SEND_URL);
    expect(call?.init?.method).toBe("POST");
    expect(JSON.parse(String(call?.init?.body))).toEqual({
      chat_id: 4242,
      text: "sunday?",
    });
  });

  it("honours a custom baseUrl for a local Bot API server", async () => {
    let requested = "";
    await transportWith(
      async (url) => {
        requested = String(url);
        return envelope({ ok: true, result: { message_id: 1 } });
      },
      { baseUrl: "http://127.0.0.1:8081/" },
    ).send({ handle: "lifter", text: "hi" });

    expect(requested).toBe(`http://127.0.0.1:8081/bot${TOKEN}/sendMessage`);
  });

  it("reports too-long before it calls the API", async () => {
    let called = false;
    const transport = transportWith(async () => {
      called = true;
      return envelope({ ok: true, result: { message_id: 1 } });
    });

    const result = await transport.send({ handle: "lifter", text: "x".repeat(4097) });

    expect(result).toEqual({
      ok: false,
      error: {
        kind: "too-long",
        limit: 4096,
        length: 4097,
        message: "Text is 4097 characters; the limit is 4096",
      },
    });
    expect(called).toBe(false);
  });

  it("sends a message of exactly the 4096-character limit", async () => {
    const result = await transportWith(async () =>
      envelope({ ok: true, result: { message_id: 5 } }),
    ).send({ handle: "lifter", text: "x".repeat(4096) });

    expect(result).toEqual({ ok: true, messageGuid: "5" });
  });

  it("reports no-chat when the handle has no known chat id", async () => {
    const result = await transportWith(async () => envelope({ ok: true }), {
      chatIdFor: () => undefined,
    }).send({ handle: "stranger", text: "hi" });

    expect(result).toEqual({
      ok: false,
      error: {
        kind: "no-chat",
        handle: "stranger",
        message: "No chat id for handle; the user must message the bot first",
      },
    });
  });

  it("reports no-chat when the API answers 400 chat not found", async () => {
    const result = await transportWith(async () =>
      envelope(
        { ok: false, error_code: 400, description: "Bad Request: chat not found" },
        400,
      ),
    ).send({ handle: "lifter", text: "hi" });

    expect(result).toEqual({
      ok: false,
      error: {
        kind: "no-chat",
        handle: "lifter",
        message: "Bad Request: chat not found",
      },
    });
  });

  it("reports unauthorized on 401", async () => {
    const result = await transportWith(async () =>
      envelope({ ok: false, error_code: 401, description: "Unauthorized" }, 401),
    ).send({ handle: "lifter", text: "hi" });

    expect(result).toEqual({
      ok: false,
      error: { kind: "unauthorized", message: "Unauthorized" },
    });
  });

  it("reports rejected with the description on other 4xx", async () => {
    const badRequest = await transportWith(async () =>
      envelope(
        { ok: false, error_code: 400, description: "Bad Request: message text is empty" },
        400,
      ),
    ).send({ handle: "lifter", text: "hi" });
    const blocked = await transportWith(async () =>
      envelope(
        { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" },
        403,
      ),
    ).send({ handle: "lifter", text: "hi" });

    expect(badRequest).toEqual({
      ok: false,
      error: {
        kind: "rejected",
        status: 400,
        message: "Bad Request: message text is empty",
      },
    });
    expect(blocked).toEqual({
      ok: false,
      error: {
        kind: "rejected",
        status: 403,
        message: "Forbidden: bot was blocked by the user",
      },
    });
  });

  describe("when fetch throws or the body cannot be read", () => {
    const input = { handle: "lifter", text: "hi" };

    it("refused connection is unreachable", async () => {
      const transport = transportWith(async () => {
        throw undiciFailure("ECONNREFUSED");
      });

      const result = await transport.send(input);

      expect(result).toEqual({
        ok: false,
        error: { kind: "unreachable", message: "TypeError: fetch failed" },
      });
    });

    it("a base URL that cannot be parsed is unreachable and never calls fetch", async () => {
      let called = false;
      const transport = transportWith(
        async () => {
          called = true;
          return envelope({ ok: true, result: { message_id: 1 } });
        },
        { baseUrl: "not a url" },
      );

      const result = await transport.send(input);

      expect(!result.ok && result.error.kind).toBe("unreachable");
      expect(called).toBe(false);
    });

    it("reset after write is indeterminate", async () => {
      const transport = transportWith(async () => {
        throw undiciFailure("ECONNRESET");
      });

      const result = await transport.send(input);

      expect(result).toEqual({
        ok: false,
        error: { kind: "indeterminate", message: "TypeError: fetch failed" },
      });
    });

    it("timeout awaiting response is indeterminate", async () => {
      const headersTimeout = transportWith(async () => {
        throw undiciFailure("UND_ERR_HEADERS_TIMEOUT");
      });
      const signalTimeout = transportWith(async () => {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      });

      const results = [await headersTimeout.send(input), await signalTimeout.send(input)];

      expect(results.map((r) => !r.ok && r.error.kind)).toEqual(["indeterminate", "indeterminate"]);
    });

    it("unknown error shape is indeterminate", async () => {
      const transport = transportWith(async () => {
        throw new TypeError("Network connection lost.");
      });

      const result = await transport.send(input);

      expect(result).toEqual({
        ok: false,
        error: { kind: "indeterminate", message: "TypeError: Network connection lost." },
      });
    });

    it("a 2xx whose body cannot be parsed is indeterminate", async () => {
      const transport = transportWith(async () => unreadable(200));

      const result = await transport.send(input);

      expect(result).toEqual({
        ok: false,
        error: {
          kind: "indeterminate",
          message: "HTTP 200 with a body that could not be read; the message may have been sent",
        },
      });
    });

    it("HTTP error statuses unchanged, even with a body that cannot be parsed", async () => {
      const statuses = { 400: "rejected", 401: "unauthorized", 403: "rejected", 429: "rejected", 500: "unknown", 502: "unknown" };

      const kinds = await Promise.all(
        Object.keys(statuses).map(async (status) => {
          const result = await transportWith(async () => unreadable(Number(status))).send(input);
          return [status, !result.ok && result.error.kind];
        }),
      );

      expect(Object.fromEntries(kinds)).toEqual(statuses);
    });
  });

  it("reports unknown on a 5xx and when chatIdFor throws", async () => {
    const serverError = await transportWith(async () =>
      envelope({ ok: false, description: "Internal Server Error" }, 500),
    ).send({ handle: "lifter", text: "hi" });
    const lookupError = await transportWith(async () => envelope({ ok: true }), {
      chatIdFor: () => {
        throw new Error("chat lookup exploded");
      },
    }).send({ handle: "lifter", text: "hi" });

    expect(serverError).toEqual({
      ok: false,
      error: { kind: "unknown", message: "HTTP 500: Internal Server Error" },
    });
    expect(lookupError).toEqual({
      ok: false,
      error: { kind: "unknown", message: "Error: chat lookup exploded" },
    });
  });

  it("treats a 200 carrying ok:false as a failure, not a send", async () => {
    const result = await transportWith(async () =>
      envelope({ ok: false, description: "Bad Request: chat not found" }, 200),
    ).send({ handle: "lifter", text: "hi" });

    expect(result).toEqual({
      ok: false,
      error: { kind: "unknown", message: "HTTP 200: Bad Request: chat not found" },
    });
  });
});

describe("token redaction", () => {
  it("keeps the token out of a fetch error that embeds the whole url", async () => {
    const result = await transportWith(async () => {
      throw new TypeError(`request to ${SEND_URL} failed, reason: ECONNREFUSED`);
    }).send({ handle: "lifter", text: "hi" });

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(TOKEN);
    expect(serialized).toContain("***");
  });

  it("keeps the token out of every other error branch", async () => {
    const results = await Promise.all([
      transportWith(async () =>
        envelope({ ok: false, description: `Unauthorized: ${TOKEN}` }, 401),
      ).send({ handle: "lifter", text: "hi" }),
      transportWith(async () =>
        envelope({ ok: false, description: `rejected ${encodeURIComponent(TOKEN)}` }, 400),
      ).send({ handle: "lifter", text: "hi" }),
      transportWith(async () => envelope({ ok: true }), {
        chatIdFor: () => {
          throw new Error(`lookup used ${TOKEN}`);
        },
      }).send({ handle: "lifter", text: "hi" }),
    ]);

    for (const result of results) {
      expect(JSON.stringify(result)).not.toContain(TOKEN);
      expect(JSON.stringify(result)).toContain("***");
    }
  });

  it("redacts both the raw and the url-encoded form", () => {
    const token = "12345:AA/bb+cc";
    const line = `path /bot${encodeURIComponent(token)}/ and raw ${token}`;
    expect(redactToken(line, token)).toBe("path /bot***/ and raw ***");
  });
});
