import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { factoryGateAnswer, type GateAnswerRequest } from "./gate-answer.js";

const REQUEST: GateAnswerRequest = {
  runId: "run-1",
  gateId: "run-1/approve-merge:1",
  headSha: "0123456789abcdef0123456789abcdef01234567",
  tree: "fedcba9876543210fedcba9876543210fedcba98",
  packetSha: "a".repeat(64),
  roundId: "orbit-retry-r1",
  choice: "merge",
};

let server: Server | undefined;
let seen: { url?: string; method?: string; headers?: IncomingHttpHeaders; body?: unknown };

async function factoryAnswering(status: number, body: unknown): Promise<number> {
  server = createServer((req, res) => {
    let text = "";
    req.on("data", (chunk) => (text += chunk));
    req.on("end", () => {
      seen = { url: req.url, method: req.method, headers: req.headers, body: JSON.parse(text) };
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

afterEach(async () => {
  await new Promise((resolve) => (server ? server.close(resolve) : resolve(undefined)));
  server = undefined;
});

describe("factoryGateAnswer", () => {
  it("posts the strict body to the answer route with the rpc client header", async () => {
    const client = factoryGateAnswer(await factoryAnswering(200, { outcome: "already", gateId: REQUEST.gateId }));

    await client.post(REQUEST);

    expect([seen.method, seen.url, seen.headers?.["x-titan-client"], seen.body]).toEqual(["POST", "/gates/answer-ship", "rpc-client", REQUEST]);
  });

  it.each([
    [200, { outcome: "resolved", gateId: "g", choice: "send-back" }, { status: "resolved", gateId: "g", choice: "send-back" }],
    [200, { outcome: "already", gateId: "g" }, { status: "already", gateId: "g" }],
    [409, { outcome: "moved", currentHead: "b".repeat(40), waitsOn: "ci" }, { status: "moved", currentHead: "b".repeat(40), waitsOn: "ci" }],
    [410, { outcome: "gone", reason: "gate settled" }, { status: "gone", reason: "gate settled" }],
    [403, { outcome: "refused", reason: "resolver", detail: "no" }, { status: "refused", reason: "resolver", detail: "no" }],
    [422, { outcome: "refused", reason: "feedback-mismatch", detail: "x" }, { status: "refused", reason: "feedback-mismatch", detail: "x" }],
    [400, { ok: false, error: "body must be {...}" }, { status: "refused", reason: "bad-request", detail: "body must be {...}" }],
    [413, { ok: false, error: "too big" }, { status: "refused", reason: "too-large", detail: "too big" }],
    [404, { ok: false, error: "not found" }, { status: "off" }],
  ])("maps %i to a recorded outcome", async (status, body, expected) => {
    const client = factoryGateAnswer(await factoryAnswering(status, body));

    expect(await client.post(REQUEST)).toEqual(expected);
  });

  it.each([503, 500])("treats %i as unreachable so a retry can follow", async (status) => {
    const client = factoryGateAnswer(await factoryAnswering(status, { ok: false, error: "github unreadable" }));

    expect(await client.post(REQUEST)).toMatchObject({ status: "unreachable" });
  });

  it("treats a 200 that is not a known outcome as unreachable, never as resolved", async () => {
    const client = factoryGateAnswer(await factoryAnswering(200, { hello: "world" }));

    expect(await client.post(REQUEST)).toMatchObject({ status: "unreachable" });
  });

  it("returns unreachable, not a rejection, when nothing listens", async () => {
    const port = await factoryAnswering(200, {});
    await new Promise((resolve) => server!.close(resolve));
    server = undefined;

    expect(await factoryGateAnswer(port, 500).post(REQUEST)).toMatchObject({ status: "unreachable" });
  });
});
