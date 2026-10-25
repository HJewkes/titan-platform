import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { brokerVerdicter, type VerdictOutcome } from "./broker-verdict.js";

const TOKEN = "test-token-0";
const MSG = "msg/0001 a";
const PORT = 4711;

interface Call {
  url: string;
  init: RequestInit | undefined;
}

let dir: string;
let tokenPath: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "console-broker-verdict-"));
  tokenPath = path.join(dir, "ui.token");
  await writeFile(tokenPath, `${TOKEN}\n`, { mode: 0o600 });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A stub fetch that records each call and answers with `reply`, or throws when `reply` is an Error. */
function stub(reply: Response | Error): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fake = (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(url), init });
    return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply.clone());
  };
  return { fetch: fake as typeof fetch, calls };
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("brokerVerdicter", () => {
  it("posts one permission verdict to the encoded queue route with the token, owner channel and client headers", async () => {
    const broker = stub(json(200, { ok: true }));

    const outcome = await brokerVerdicter({ port: PORT, tokenPath, fetch: broker.fetch }).permission(MSG, "allow");

    expect(outcome).toEqual({ status: "answered" });
    expect(broker.calls).toHaveLength(1);
    expect(broker.calls[0]?.url).toBe(`http://127.0.0.1:${PORT}/api/queue/msg%2F0001%20a/permission`);
    expect(broker.calls[0]?.init).toMatchObject({
      method: "POST",
      redirect: "manual",
      body: JSON.stringify({ behavior: "allow" }),
      headers: {
        "content-type": "application/json",
        "X-Agent-Chat-Token": TOKEN,
        "X-Owner-Channel": "console",
        "x-titan-client": "titan-console",
      },
    });
  });

  it("sends the endorse text byte for byte, with trailing whitespace and an astral character", async () => {
    const broker = stub(json(200, { ok: true }));
    const text = "ship \u{1F680} it \n";

    await brokerVerdicter({ port: PORT, tokenPath, fetch: broker.fetch }).endorse(MSG, text, "peer-0");

    expect(broker.calls).toHaveLength(1);
    expect(broker.calls[0]?.url).toBe(`http://127.0.0.1:${PORT}/api/queue/msg%2F0001%20a/endorse`);
    const body: unknown = JSON.parse(String(broker.calls[0]?.init?.body));
    expect(body).toEqual({ text, to: "peer-0" });
  });

  it("re-reads the token on every call", async () => {
    const broker = stub(json(200, { ok: true }));
    const verdicter = brokerVerdicter({ port: PORT, tokenPath, fetch: broker.fetch });

    await verdicter.permission(MSG, "deny");
    await writeFile(tokenPath, "test-token-1\n", { mode: 0o600 });
    await verdicter.permission(MSG, "deny");

    const tokens = broker.calls.map((call) => (call.init?.headers as Record<string, string>)["X-Agent-Chat-Token"]);
    expect(tokens).toEqual([TOKEN, "test-token-1"]);
  });

  it.each([
    ["is not an open permission prompt"],
    ["no item with id msg-0001"],
    ["msg-0001 has no hook waiting"],
  ])("reads %s as closed, not as an error", async (reason) => {
    const broker = stub(json(200, { ok: false, reason }));

    const outcome = await brokerVerdicter({ port: PORT, tokenPath, fetch: broker.fetch }).permission(MSG, "allow");

    expect(outcome).toEqual({ status: "closed", reason });
  });

  it("reads any other refusal on a 200 as refused with the broker's reason", async () => {
    const broker = stub(json(200, { ok: false, reason: "recipient moved" }));

    const outcome = await brokerVerdicter({ port: PORT, tokenPath, fetch: broker.fetch }).endorse(MSG, "x", "peer-0");

    expect(outcome).toEqual({ status: "refused", reason: "recipient moved" });
  });

  it.each([[400], [403], [404]])("reads a %i as refused", async (status) => {
    const broker = stub(json(status, { error: "not for you" }));

    const outcome = await brokerVerdicter({ port: PORT, tokenPath, fetch: broker.fetch }).permission(MSG, "allow");

    expect(outcome).toEqual({ status: "refused", reason: "not for you" });
  });

  it("reads a 404 with no body, as from a broker without the routes, as refused", async () => {
    const broker = stub(new Response("Not Found", { status: 404 }));

    const outcome = await brokerVerdicter({ port: PORT, tokenPath, fetch: broker.fetch }).permission(MSG, "allow");

    expect(outcome).toEqual({ status: "refused", reason: "broker answered 404" });
  });

  it.each([[500], [302]])("reads a %i as unreachable", async (status) => {
    const broker = stub(new Response(null, { status }));

    const outcome = await brokerVerdicter({ port: PORT, tokenPath, fetch: broker.fetch }).permission(MSG, "allow");

    expect(outcome).toMatchObject({ status: "unreachable" });
  });

  it("reads a fetch that throws as unreachable instead of rejecting", async () => {
    const broker = stub(new Error("connect ECONNREFUSED"));

    const outcome = await brokerVerdicter({ port: PORT, tokenPath, fetch: broker.fetch }).permission(MSG, "allow");

    expect(outcome).toEqual({ status: "unreachable", detail: "connect ECONNREFUSED" });
  });

  it("refuses a token file others can read, before anything is posted", async () => {
    const broker = stub(json(200, { ok: true }));
    await chmod(tokenPath, 0o644);

    const outcome = await brokerVerdicter({ port: PORT, tokenPath, fetch: broker.fetch }).permission(MSG, "allow");

    expect(outcome).toMatchObject({ status: "unreachable", detail: expect.stringMatching(/mode 644/) });
    expect(broker.calls).toEqual([]);
  });

  it("carries the token in no outcome, even when the broker echoes it", async () => {
    const echoes = [
      json(200, { ok: true, reason: TOKEN }),
      json(200, { ok: false, reason: `${TOKEN} is not an open prompt` }),
      json(200, { ok: false, reason: `bad ${TOKEN}` }),
      json(403, { error: `bad ${TOKEN}` }),
      new Response(TOKEN, { status: 503 }),
      new Error(`connect failed with ${TOKEN}`),
    ];
    const outcomes: VerdictOutcome[] = [];

    for (const echo of echoes) {
      const broker = stub(echo);
      outcomes.push(await brokerVerdicter({ port: PORT, tokenPath, fetch: broker.fetch }).permission(MSG, "allow"));
    }

    expect(outcomes.filter((outcome) => JSON.stringify(outcome).includes(TOKEN))).toEqual([]);
  });
});
