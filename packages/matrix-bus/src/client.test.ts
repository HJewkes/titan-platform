import { describe, expect, it, vi } from "vitest";
import { AppserviceClient, loginPassword } from "./client.js";
import { MatrixError } from "./http.js";
import { ContentTooLargeError } from "./size.js";

const BASE = "http://hub.test";

function mockFetch(respond: (url: URL, init: RequestInit) => { status?: number; body: unknown }) {
  return vi.fn(async (input: string, init: RequestInit = {}) => {
    const { status = 200, body } = respond(new URL(input), init);
    return new Response(JSON.stringify(body), { status });
  });
}

const urlOf = (fetch: ReturnType<typeof mockFetch>, call = 0) => new URL(fetch.mock.calls[call]![0]);

describe("AppserviceClient", () => {
  it("adds ?user_id= when masquerading as a namespace user", async () => {
    const fetch = mockFetch(() => ({ body: { event_id: "$1" } }));
    const client = new AppserviceClient({ baseUrl: BASE, asToken: "as", userId: "@ac-edge1-a:hub.test", fetch });

    await client.send("!room:hub.test", "m.room.message", { body: "hi" });

    const url = urlOf(fetch);
    expect(url.searchParams.get("user_id")).toBe("@ac-edge1-a:hub.test");
    expect(url.pathname).toMatch(/^\/_matrix\/client\/v3\/rooms\/!room%3Ahub\.test\/send\/m\.room\.message\/.+/);
    expect(fetch.mock.calls[0]![1]!.headers).toMatchObject({ authorization: "Bearer as" });
  });

  it("omits user_id when acting as the token's own sender", async () => {
    const fetch = mockFetch(() => ({ body: { user_id: "@ac-edge1:hub.test" } }));
    const client = new AppserviceClient({ baseUrl: BASE, asToken: "as", userId: "@ac-edge1:hub.test", sender: "@ac-edge1:hub.test", fetch });

    await client.whoami();

    expect(urlOf(fetch).searchParams.has("user_id")).toBe(false);
  });

  it("uses a fresh transaction id per send unless one is given", async () => {
    const fetch = mockFetch(() => ({ body: { event_id: "$1" } }));
    const client = new AppserviceClient({ baseUrl: BASE, asToken: "as", fetch });

    await client.send("!r", "m.reaction", {});
    await client.send("!r", "m.reaction", {});
    await client.send("!r", "m.reaction", {}, "txn-fixed");

    const txns = fetch.mock.calls.map(([input]) => new URL(input).pathname.split("/").at(-1));
    expect(new Set(txns).size).toBe(3);
    expect(txns[2]).toBe("txn-fixed");
  });

  it("refuses oversized content before any request", async () => {
    const fetch = mockFetch(() => ({ body: {} }));
    const client = new AppserviceClient({ baseUrl: BASE, asToken: "as", fetch });

    await expect(client.send("!r", "m.room.message", { body: "x".repeat(70_000) })).rejects.toBeInstanceOf(ContentTooLargeError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("raises a MatrixError carrying status and errcode", async () => {
    const fetch = mockFetch(() => ({ status: 403, body: { errcode: "M_FORBIDDEN", error: "no" } }));
    const client = new AppserviceClient({ baseUrl: BASE, asToken: "as", fetch });

    const err = await client.send("!r", "m.reaction", {}).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MatrixError);
    expect(err).toMatchObject({ status: 403, errcode: "M_FORBIDDEN" });
  });
});

describe("AppserviceClient.syncLoop", () => {
  const batch = (next: string, events: unknown[]) => ({ next_batch: next, rooms: { join: { "!q:hub.test": { timeline: { events } } } } });

  it("carries since from each batch into the next request and tags events with their room", async () => {
    const pages = [batch("s1", [{ type: "m.room.message", event_id: "$a" }]), batch("s2", [])];
    const fetch = mockFetch(() => ({ body: pages.shift() }));
    const client = new AppserviceClient({ baseUrl: BASE, asToken: "as", userId: "@ac-edge1:hub.test", fetch });
    const seen = [];

    for await (const { since, events } of client.syncLoop({ since: "s0", timeoutMs: 5, filter: { room: { rooms: ["!q:hub.test"] } } })) {
      seen.push({ since, events: events.map((e) => [e.event_id, e.room_id]) });
      if (seen.length === 2) break;
    }

    expect(seen).toEqual([{ since: "s1", events: [["$a", "!q:hub.test"]] }, { since: "s2", events: [] }]);
    expect([0, 1].map((call) => urlOf(fetch, call).searchParams.get("since"))).toEqual(["s0", "s1"]);
    expect(urlOf(fetch).searchParams.get("user_id")).toBe("@ac-edge1:hub.test");
    expect(JSON.parse(urlOf(fetch).searchParams.get("filter")!)).toEqual({ room: { rooms: ["!q:hub.test"] } });
  });

  it("carries limited and prev_batch from a room's timeline", async () => {
    const fetch = mockFetch(() => ({
      body: {
        next_batch: "s1",
        rooms: { join: { "!q:hub.test": { timeline: { events: [], limited: true, prev_batch: "p1" } } } },
      },
    }));
    const client = new AppserviceClient({ baseUrl: BASE, asToken: "as", fetch });

    const batches = [];
    for await (const batch of client.syncLoop({ since: "s0", timeoutMs: 5 })) {
      batches.push(batch);
      break;
    }

    expect(batches).toEqual([{ since: "s1", events: [], limited: true, prev_batch: "p1" }]);
  });

  it("defaults limited to false and prev_batch to undefined when the response omits them", async () => {
    const fetch = mockFetch(() => ({ body: batch("s1", []) }));
    const client = new AppserviceClient({ baseUrl: BASE, asToken: "as", fetch });

    const batches = [];
    for await (const b of client.syncLoop({ since: "s0", timeoutMs: 5 })) {
      batches.push(b);
      break;
    }

    expect(batches).toEqual([{ since: "s1", events: [], limited: false, prev_batch: undefined }]);
  });

  it("ends without error when aborted mid-poll", async () => {
    const controller = new AbortController();
    const fetch = vi.fn(async (_input: string, init: RequestInit = {}) => {
      controller.abort();
      throw init.signal?.reason;
    });
    const client = new AppserviceClient({ baseUrl: BASE, asToken: "as", fetch });

    const batches = [];
    for await (const b of client.syncLoop({ signal: controller.signal })) batches.push(b);

    expect(batches).toEqual([]);
  });
});

describe("loginPassword", () => {
  it("returns a client acting as the logged-in user without masquerading", async () => {
    const fetch = mockFetch((url) =>
      url.pathname.endsWith("/login") ? { body: { user_id: "@owner:hub.test", access_token: "tok" } } : { body: { user_id: "@owner:hub.test" } },
    );

    const owner = await loginPassword(BASE, "owner", "pw", fetch);
    await owner.whoami();

    expect(owner.userId).toBe("@owner:hub.test");
    expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).toMatchObject({ type: "m.login.password", password: "pw" });
    expect(urlOf(fetch, 1).searchParams.has("user_id")).toBe(false);
    expect(fetch.mock.calls[1]![1]!.headers).toMatchObject({ authorization: "Bearer tok" });
  });
});
