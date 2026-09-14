import { describe, expect, it } from "vitest";
import type { BlueBubblesConfig } from "./bluebubbles.js";
import { probeLiveness } from "./liveness.js";

const PASSWORD = "hunter2-secret";

function config(doFetch: typeof fetch): BlueBubblesConfig {
  return {
    baseUrl: "http://127.0.0.1:1234",
    password: PASSWORD,
    chatGuidFor: () => undefined,
    fetch: doFetch,
  };
}

describe("probeLiveness", () => {
  it("reports alive with the server metadata", async () => {
    let requested = "";
    const result = await probeLiveness(
      config(async (url) => {
        requested = String(url);
        return new Response(
          JSON.stringify({
            status: 200,
            message: "Success",
            data: {
              os_version: "11.6.0",
              server_version: "11.1.1",
              private_api: true,
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }),
      { timeoutMs: 1000 },
    );

    expect(result).toEqual({
      state: "alive",
      serverVersion: "11.1.1",
      osVersion: "11.6.0",
      privateApi: true,
    });
    expect(requested).toBe(
      `http://127.0.0.1:1234/api/v1/server/info?password=${encodeURIComponent(PASSWORD)}`,
    );
  });

  it("reports dark/unreachable when the connection fails", async () => {
    const result = await probeLiveness(
      config(async () => {
        throw new TypeError("fetch failed");
      }),
      { timeoutMs: 1000 },
    );

    expect(result).toEqual({ state: "dark", reason: "unreachable" });
  });

  it("reports dark/timeout when the server never answers", async () => {
    const result = await probeLiveness(
      config(() => new Promise<Response>(() => {})),
      { timeoutMs: 10 },
    );

    expect(result).toEqual({ state: "dark", reason: "timeout" });
  });

  it("aborts the request it gave up on", async () => {
    let signal: AbortSignal | undefined;
    await probeLiveness(
      config((_url, init) => {
        signal = init?.signal ?? undefined;
        return new Promise<Response>(() => {});
      }),
      { timeoutMs: 10 },
    );

    expect(signal?.aborted).toBe(true);
  });

  it("reports dark/unauthorized on a bad password", async () => {
    const result = await probeLiveness(
      config(async () => new Response("{}", { status: 401 })),
      { timeoutMs: 1000 },
    );

    expect(result).toEqual({ state: "dark", reason: "unauthorized" });
  });

  it("reports dark/bad-response for a 500 and for a body with no data", async () => {
    const serverError = await probeLiveness(
      config(async () => new Response("{}", { status: 500 })),
      { timeoutMs: 1000 },
    );
    const notJson = await probeLiveness(
      config(async () => new Response("<html>proxy</html>")),
      { timeoutMs: 1000 },
    );

    expect(serverError).toEqual({ state: "dark", reason: "bad-response" });
    expect(notJson).toEqual({ state: "dark", reason: "bad-response" });
  });
});
