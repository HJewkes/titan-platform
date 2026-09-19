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

  it("posts wire-shaped JSON to the command's route under the origin", async () => {
    const seen: Array<[string, RequestInit | undefined]> = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      seen.push([String(input), init]);
      return new Response('{"ok":true,"data":1}');
    };
    await liveSource({ origin: "http://127.0.0.1:7400/", fetch }).call("task.list", { a: undefined, b: 1 });
    expect(seen[0]?.[0]).toBe("http://127.0.0.1:7400/rpc/task.list");
    expect(seen[0]?.[1]).toMatchObject({ method: "POST", body: '{"b":1}', headers: { "content-type": "application/json" } });
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
