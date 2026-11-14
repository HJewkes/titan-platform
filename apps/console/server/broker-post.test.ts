import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { brokerAnswerer } from "./broker-answer.js";
import { brokerPost, type BrokerOutcome } from "./broker-post.js";
import { brokerVerdicter } from "./broker-verdict.js";

const TOKEN = "test-token-post";
const PORT = 4711;

let dir: string;
let tokenPath: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "console-broker-post-"));
  tokenPath = path.join(dir, "ui.token");
  await writeFile(tokenPath, `${TOKEN}\n`, { mode: 0o600 });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const replying = (reply: Response | Error): typeof fetch => () => (reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply.clone()));

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("brokerPost", () => {
  it("gives the answerer and the verdicter the same token-free outcome for each broker reply", async () => {
    const replies = [json(200, { ok: false, reason: `bad ${TOKEN}` }), json(403, { error: `bad ${TOKEN}` }), new Error(`connect failed with ${TOKEN}`)];
    const answered: BrokerOutcome[] = [];
    const decided: BrokerOutcome[] = [];

    for (const reply of replies) {
      answered.push(await brokerAnswerer({ port: PORT, tokenPath, fetch: replying(reply) }).answer("msg-1", "yes"));
      decided.push(await brokerVerdicter({ port: PORT, tokenPath, fetch: replying(reply) }).permission("msg-1", "allow"));
    }

    expect(answered).toEqual(decided);
    expect(JSON.stringify(answered)).not.toContain(TOKEN);
  });

  it.each([
    ["a 200 refusal", json(200, { ok: false, reason: `bad ${TOKEN}` }), { status: "refused", reason: "bad [token]" }],
    ["a 4xx error", json(403, { error: `bad ${TOKEN}` }), { status: "refused", reason: "bad [token]" }],
    ["a closed reason", json(200, { ok: false, reason: `${TOKEN} no item with id` }), { status: "closed", reason: "[token] no item with id" }],
    ["a transport error", new Error(`connect failed with ${TOKEN}`), { status: "unreachable", detail: "connect failed with [token]" }],
  ])("replaces the token in %s with a marker", async (_case, reply, expected) => {
    const options = { port: PORT, tokenPath, fetch: replying(reply) };

    const outcome = await brokerPost(options, { route: "/api/x", payload: {}, closedReason: /no item with id/, refusedFallback: "none" });

    expect(outcome).toEqual(expected);
  });

  it("uses the caller's fallback when a 200 refusal carries no reason", async () => {
    const options = { port: PORT, tokenPath, fetch: replying(json(200, { ok: false })) };

    const outcome = await brokerPost(options, { route: "/api/x", payload: {}, closedReason: /closed/, refusedFallback: "not posted" });

    expect(outcome).toEqual({ status: "refused", reason: "not posted" });
  });

  it("names the route when the broker answers 5xx", async () => {
    const options = { port: PORT, tokenPath, fetch: replying(new Response(null, { status: 502 })) };

    const outcome = await brokerPost(options, { route: "/api/x", payload: {}, closedReason: /closed/, refusedFallback: "none" });

    expect(outcome).toEqual({ status: "unreachable", detail: "agent-chat broker /api/x answered 502" });
  });
});
