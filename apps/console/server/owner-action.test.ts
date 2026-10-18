import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { factoryOwnerAction } from "./owner-action.js";
import { closedPort } from "./test-support.js";

const GATE = "11111111-0000-4000-8000-000000000001/approve-merge";
const RUN = "22222222-0000-4000-8000-000000000002";
const HEAD = "abcdef1234567890abcdef1234567890abcdef12";

let server: Server | undefined;
let seen: { url?: string; body: string; client?: string }[] = [];

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
  seen = [];
});

/** A factory that answers every post with one fixed status, body and headers. */
async function factoryAnswering(status: number, body: unknown, headers: Record<string, string> = {}): Promise<number> {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      seen.push({ url: req.url, body: Buffer.concat(chunks).toString("utf8"), client: [req.headers["x-titan-client"]].flat()[0] });
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    });
  });
  const listening = server;
  await new Promise<void>((resolve) => listening.listen(0, "127.0.0.1", resolve));
  const address = listening.address();
  if (address === null || typeof address === "string") throw new Error("the fake factory has no port");
  return address.port;
}

describe("factoryOwnerAction", () => {
  it("posts only the action id to the console-action route with the client header", async () => {
    const port = await factoryAnswering(200, { outcome: "resolved", gateId: GATE });

    await factoryOwnerAction(port).post("a".repeat(64));

    expect(seen).toEqual([{ url: "/owner/console-action", body: JSON.stringify({ actionId: "a".repeat(64) }), client: "rpc-client" }]);
  });

  it.each([
    [200, { outcome: "resolved", gateId: GATE }, { status: "resolved", gateId: GATE }],
    [200, { outcome: "already", gateId: GATE }, { status: "already", gateId: GATE }],
    [200, { outcome: "released", runId: RUN, stillHeld: null }, { status: "released", runId: RUN, stillHeld: null }],
    [200, { outcome: "released", runId: RUN, stillHeld: "g10-review: opus review at head" }, { status: "released", runId: RUN, stillHeld: "g10-review: opus review at head" }],
    [200, { outcome: "already", runId: RUN }, { status: "already", runId: RUN }],
    [409, { outcome: "moved", currentHead: HEAD }, { status: "moved", currentHead: HEAD }],
    [410, { outcome: "gone", reason: "no gate" }, { status: "gone", reason: "no gate" }],
    [403, { outcome: "refused", reason: "resolver", detail: "owner-terminal only" }, { status: "refused", reason: "resolver", detail: "owner-terminal only" }],
    [422, { outcome: "refused", reason: "record", detail: "bad record" }, { status: "refused", reason: "record", detail: "bad record" }],
    [400, { ok: false, error: "body must be {actionId}" }, { status: "refused", reason: "bad-request", detail: "body must be {actionId}" }],
    [404, { ok: false }, { status: "off" }],
  ])("reads a %i %j as its pinned outcome", async (status, body, outcome) => {
    const port = await factoryAnswering(status, body);

    expect(await factoryOwnerAction(port).post("a".repeat(64))).toEqual(outcome);
  });

  it.each([
    ["a 503 the factory could not read GitHub", 503, { outcome: "refused", reason: "github-unreadable", detail: "rate limited" }],
    ["a 500", 500, { ok: false, error: "answering the console action failed" }],
    ["a 200 with no outcome", 200, { ok: true }],
    ["a redirect", 302, {}],
  ])("reads %s as unreachable, so a retry may land", async (_, status, body) => {
    const port = await factoryAnswering(status, body, status === 302 ? { location: "http://127.0.0.1:1/elsewhere" } : {});

    expect(await factoryOwnerAction(port).post("a".repeat(64))).toMatchObject({ status: "unreachable" });
  });

  it("reads a factory that is down as unreachable instead of rejecting", async () => {
    expect(await factoryOwnerAction(await closedPort()).post("a".repeat(64))).toMatchObject({ status: "unreachable" });
  });
});
