import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { brokerAnswerer } from "./broker-answer.js";
import { closedPort } from "./test-support.js";

const TOKEN = "test-ui-token";
const MSG = "msg-0001";

interface Seen {
  url: string;
  token: string | undefined;
  client: string | undefined;
  body: unknown;
}

let dir: string;
let tokenPath: string;
let closeBroker: (() => Promise<void>) | undefined;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "console-broker-answer-"));
  tokenPath = path.join(dir, "ui.token");
  await writeFile(tokenPath, `${TOKEN}\n`, { mode: 0o600 });
});

afterEach(async () => {
  await closeBroker?.();
  closeBroker = undefined;
  await rm(dir, { recursive: true, force: true });
});

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(String(chunk)));
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString() || "null");
  return parsed;
}

const header = (req: IncomingMessage, name: string): string | undefined => {
  const value = req.headers[name];
  return typeof value === "string" ? value : undefined;
};

/** A loopback broker that records each request and answers it with `reply`. */
async function startBroker(reply: (res: ServerResponse, url: string) => void): Promise<{ port: number; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    void readBody(req).then((body) => {
      seen.push({ url: req.url ?? "", token: header(req, "x-agent-chat-token"), client: header(req, "x-titan-client"), body });
      reply(res, req.url ?? "");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closeBroker = () => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(() => resolve()));
  };
  const address = server.address();
  return { port: typeof address === "object" && address !== null ? address.port : 0, seen };
}

const json = (status: number, body: unknown) => (res: ServerResponse) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

describe("brokerAnswerer", () => {
  it("posts the answer on channel dashboard with the token and reads ok as answered", async () => {
    const broker = await startBroker(json(200, { ok: true }));

    const outcome = await brokerAnswerer({ port: broker.port, tokenPath }).answer(MSG, "ship it");

    expect(outcome).toEqual({ status: "answered" });
    expect(broker.seen).toEqual([{ url: "/api/answer", token: TOKEN, client: "titan-console", body: { msgId: MSG, text: "ship it", channel: "dashboard" } }]);
  });

  it("reads a question someone else answered first as closed, not as an error", async () => {
    const broker = await startBroker(json(200, { ok: false, reason: `${MSG} is not an open item` }));

    const outcome = await brokerAnswerer({ port: broker.port, tokenPath }).answer(MSG, "ship it");

    expect(outcome).toEqual({ status: "closed", reason: `${MSG} is not an open item` });
  });

  it("reads any other verdict refusal as refused with the broker's reason", async () => {
    const broker = await startBroker(json(200, { ok: false, reason: `${MSG} is a permission prompt; it is approved or denied, not answered` }));

    const outcome = await brokerAnswerer({ port: broker.port, tokenPath }).answer(MSG, "yes");

    expect(outcome).toMatchObject({ status: "refused", reason: expect.stringMatching(/permission prompt/) });
  });

  it("reads a 400 as refused with the broker's error", async () => {
    const broker = await startBroker(json(400, { error: "text is required" }));

    const outcome = await brokerAnswerer({ port: broker.port, tokenPath }).answer(MSG, "x");

    expect(outcome).toEqual({ status: "refused", reason: "text is required" });
  });

  it("does not follow a redirect, so the token is sent once and the answer is unreachable", async () => {
    const broker = await startBroker((res, url) => {
      if (url === "/api/answer") {
        res.writeHead(302, { location: "/elsewhere" });
        res.end();
      } else json(200, { ok: true })(res);
    });

    const outcome = await brokerAnswerer({ port: broker.port, tokenPath }).answer(MSG, "ship it");

    expect(outcome).toMatchObject({ status: "unreachable" });
    expect(broker.seen.map((each) => each.url)).toEqual(["/api/answer"]);
  });

  it("reads a broker that is down as unreachable", async () => {
    const outcome = await brokerAnswerer({ port: await closedPort(), tokenPath }).answer(MSG, "ship it");

    expect(outcome).toMatchObject({ status: "unreachable" });
  });

  it("refuses a token file others can read, before anything is posted", async () => {
    const broker = await startBroker(json(200, { ok: true }));
    await chmod(tokenPath, 0o644);

    const outcome = await brokerAnswerer({ port: broker.port, tokenPath }).answer(MSG, "ship it");

    expect(outcome).toMatchObject({ status: "unreachable", detail: expect.stringMatching(/mode 644/) });
    expect(broker.seen).toEqual([]);
  });
});
