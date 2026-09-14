import { describe, expect, it } from "vitest";
import type { BlueBubblesConfig } from "./bluebubbles.js";
import { BlueBubblesTransport, redactPassword } from "./bluebubbles.js";

const PASSWORD = "hunter2-secret";

function envelope(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function transportWith(
  doFetch: typeof fetch,
  overrides: Partial<BlueBubblesConfig> = {},
): BlueBubblesTransport {
  return new BlueBubblesTransport({
    baseUrl: "http://127.0.0.1:1234",
    password: PASSWORD,
    chatGuidFor: () => "iMessage;-;+15550000000",
    newTempGuid: () => "temp-1",
    fetch: doFetch,
    ...overrides,
  });
}

describe("BlueBubblesTransport.send", () => {
  it("posts the documented send request and returns the new message guid", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const transport = transportWith(async (url, init) => {
      calls.push({ url: String(url), init });
      return envelope({ status: 200, message: "Success", data: { guid: "m-9" } });
    });

    const result = await transport.send({ handle: "+15550000000", text: "hi" });

    expect(result).toEqual({ ok: true, messageGuid: "m-9" });
    const call = calls[0];
    expect(call?.url).toBe(
      `http://127.0.0.1:1234/api/v1/message/text?password=${encodeURIComponent(PASSWORD)}`,
    );
    expect(call?.init?.method).toBe("POST");
    expect(JSON.parse(String(call?.init?.body))).toEqual({
      chatGuid: "iMessage;-;+15550000000",
      tempGuid: "temp-1",
      message: "hi",
      method: "apple-script",
    });
  });

  it("reports no-chat when the handle has no existing conversation", async () => {
    const transport = transportWith(
      async () => envelope({}),
      { chatGuidFor: () => undefined },
    );

    const result = await transport.send({ handle: "nobody@example.com", text: "hi" });

    expect(result).toEqual({
      ok: false,
      error: {
        kind: "no-chat",
        handle: "nobody@example.com",
        message: "No chatGuid for handle; an existing conversation is required",
      },
    });
  });

  it("reports no-chat when the server answers 404", async () => {
    const transport = transportWith(async () =>
      envelope({ status: 404, error: { message: "Chat does not exist!" } }, 404),
    );

    const result = await transport.send({ handle: "+15550000000", text: "hi" });

    expect(result).toEqual({
      ok: false,
      error: {
        kind: "no-chat",
        handle: "+15550000000",
        message: "Chat does not exist!",
      },
    });
  });

  it("reports unauthorized on 401", async () => {
    const transport = transportWith(async () =>
      envelope({ error: { message: "Invalid password!" } }, 401),
    );

    const result = await transport.send({ handle: "+15550000000", text: "hi" });

    expect(result).toEqual({
      ok: false,
      error: { kind: "unauthorized", message: "Invalid password!" },
    });
  });

  it("reports rejected with the server message on a 400", async () => {
    const transport = transportWith(async () =>
      envelope(
        { error: { message: "A 'tempGuid' is required when sending via AppleScript" } },
        400,
      ),
    );

    const result = await transport.send({ handle: "+15550000000", text: "hi" });

    expect(result).toEqual({
      ok: false,
      error: {
        kind: "rejected",
        status: 400,
        message: "A 'tempGuid' is required when sending via AppleScript",
      },
    });
  });

  it("reports unreachable when fetch throws", async () => {
    const transport = transportWith(async () => {
      throw new TypeError("fetch failed");
    });

    const result = await transport.send({ handle: "+15550000000", text: "hi" });

    expect(result).toEqual({
      ok: false,
      error: { kind: "unreachable", message: "TypeError: fetch failed" },
    });
  });

  it("reports unknown on a 500 and when chatGuidFor throws", async () => {
    const serverError = await transportWith(async () =>
      envelope({ message: "Server Error" }, 500),
    ).send({ handle: "+15550000000", text: "hi" });
    expect(serverError).toEqual({
      ok: false,
      error: { kind: "unknown", message: "HTTP 500: Server Error" },
    });

    const lookupError = await transportWith(async () => envelope({}), {
      chatGuidFor: () => {
        throw new Error("chat lookup exploded");
      },
    }).send({ handle: "+15550000000", text: "hi" });
    expect(lookupError).toEqual({
      ok: false,
      error: { kind: "unknown", message: "Error: chat lookup exploded" },
    });
  });
});

describe("password redaction", () => {
  it("keeps the password out of every error branch", async () => {
    const leakyUrl = `http://127.0.0.1:1234/api/v1/message/text?password=${PASSWORD}`;
    const results = await Promise.all([
      transportWith(async () => {
        throw new TypeError(`fetch failed for ${leakyUrl}`);
      }).send({ handle: "+1", text: "hi" }),
      transportWith(async () =>
        envelope({ error: { message: `bad password ${PASSWORD}` } }, 401),
      ).send({ handle: "+1", text: "hi" }),
      transportWith(async () =>
        envelope({ error: { message: `rejected ${encodeURIComponent(PASSWORD)}` } }, 400),
      ).send({ handle: "+1", text: "hi" }),
      transportWith(async () => envelope({}), {
        chatGuidFor: () => {
          throw new Error(`lookup used ${PASSWORD}`);
        },
      }).send({ handle: "+1", text: "hi" }),
    ]);

    for (const result of results) {
      expect(JSON.stringify(result)).not.toContain(PASSWORD);
      expect(JSON.stringify(result)).toContain("***");
    }
  });

  it("redacts both the raw and the url-encoded form", () => {
    const password = "p@ss word/1";
    const line = `?password=${encodeURIComponent(password)} and raw ${password}`;
    expect(redactPassword(line, password)).toBe("?password=*** and raw ***");
  });
});
