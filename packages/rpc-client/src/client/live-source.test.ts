import { describe, expect, it } from "vitest";
import { EXIT } from "@titan-design/rpc-protocol";
import type { LiveStatus } from "./data-source.js";
import { liveSource } from "./live-source.js";

// Shapes a real daemon never sends; the real-daemon cases live in src/live.test.ts.

const answering = (body: string, status = 200): typeof fetch => async () => new Response(body, { status });

function streaming(text: string): typeof fetch {
  return async () => new Response(new Blob([text]).stream(), { headers: { "content-type": "text/event-stream" } });
}

describe("liveSource with a foreign server in the way", () => {
  it.each([
    ["JSON that is not an envelope", answering('{"message":"bad gateway"}', 502)],
    ["an HTML error page", answering("<html>502</html>", 502)],
    ["an envelope-like body with a string code", answering('{"ok":false,"error":"x","code":"64"}', 400)],
  ])("answers UNAVAILABLE for %s", async (_label, fetch) => {
    const envelope = await liveSource({ fetch }).call("task.list", {});
    expect(envelope).toMatchObject({ ok: false, code: EXIT.UNAVAILABLE });
  });

  it("answers DATAERR without dialling when the args hold a BigInt", async () => {
    let dialled = false;
    const fetch: typeof globalThis.fetch = async () => {
      dialled = true;
      return new Response("{}");
    };
    const envelope = await liveSource({ fetch }).call("task.list", { n: 1n });
    expect(envelope).toMatchObject({ ok: false, code: EXIT.DATAERR });
    expect(dialled).toBe(false);
  });

  it("posts wire-shaped JSON to the command's route under the origin", async () => {
    const seen: Array<[string, RequestInit | undefined]> = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      seen.push([String(input), init]);
      return new Response('{"ok":true,"data":1}');
    };
    await liveSource({ origin: "http://127.0.0.1:7400/", fetch }).call("task.list", { a: undefined, b: 1 });
    expect(seen[0]?.[0]).toBe("http://127.0.0.1:7400/rpc/task.list");
    expect(seen[0]?.[1]).toMatchObject({ method: "POST", body: '{"b":1}', headers: { "content-type": "application/json", "x-titan-client": "rpc-client" } });
  });
});

describe("liveSource event stream framing", () => {
  it("reports ready as open and keeps ping frames from handlers", async () => {
    const events: string[] = [];
    const statuses: LiveStatus[] = [];
    const frames = "event: ready\ndata: connected\n\nevent: ping\ndata: 1\n\nevent: change\ndata: x\n\n";
    const source = liveSource({ fetch: streaming(frames), reconnectDelayMs: 60_000 });
    const sub = source.subscribe({ onEvent: (m) => events.push(m.event), onStatus: (s) => statuses.push(s) });
    await new Promise((resolve) => setTimeout(resolve, 20));
    sub.close();
    expect(events).toEqual(["change"]);
    expect(statuses.slice(0, 2)).toEqual(["connecting", "open"]);
  });
});

describe("liveSource when the dial is refused", () => {
  it("reports a 403 Host refusal to onDialFailure", async () => {
    const reasons: string[] = [];
    const source = liveSource({ fetch: answering('{"ok":false}', 403), reconnectDelayMs: 60_000 });
    const sub = source.subscribe({ onEvent: () => {}, onDialFailure: (reason) => reasons.push(reason) });
    await new Promise((resolve) => setTimeout(resolve, 20));
    sub.close();
    expect(reasons).toEqual(["HTTP 403"]);
  });

  it("reports a fetch error's message but not the caller's own abort", async () => {
    const reasons: string[] = [];
    const refused: typeof fetch = async () => {
      throw new TypeError("fetch failed");
    };
    const hangUntilAborted: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    const failing = liveSource({ fetch: refused, reconnectDelayMs: 60_000 }).subscribe({ onEvent: () => {}, onDialFailure: (r) => reasons.push(r) });
    const closed = liveSource({ fetch: hangUntilAborted, reconnectDelayMs: 60_000 }).subscribe({ onEvent: () => {}, onDialFailure: (r) => reasons.push(r) });
    await new Promise((resolve) => setTimeout(resolve, 20));
    failing.close();
    closed.close();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(reasons).toEqual(["fetch failed"]);
  });

  it("keeps redialling, one report per dial, when onDialFailure throws", async () => {
    const reasons: string[] = [];
    const uncaught: unknown[] = [];
    const onUncaught = (err: unknown): void => void uncaught.push(err);
    process.on("uncaughtException", onUncaught);
    const source = liveSource({ fetch: answering("no", 403), reconnectDelayMs: 1, maxReconnectDelayMs: 2 });
    const sub = source.subscribe({
      onEvent: () => {},
      onDialFailure: (reason) => {
        reasons.push(reason);
        throw new Error("handler broke");
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    sub.close();
    process.off("uncaughtException", onUncaught);
    expect(reasons.length).toBeGreaterThan(1);
    expect(new Set(reasons)).toEqual(new Set(["HTTP 403"]));
    expect(uncaught).toHaveLength(reasons.length);
  });
});
