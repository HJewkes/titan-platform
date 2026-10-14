import { octokitClient, type PullRequest } from "@titan-design/github";
import { EXIT } from "@titan-design/registry";
import { partialFake } from "@titan-design/test-kit";
import { describe, expect, it } from "vitest";
import type { FactoryContext } from "../registry.js";
import type { PrSnapshot } from "../workflows/pr-snapshot.js";
import type { ShepherdServices } from "./commands.js";
import { GH_GATEWAY_COMMANDS, ghGateway, type GhCallLine } from "./gh-gateway.js";

const API = "https://api.github.com/";
const TOKEN = "ghp_synthetic_gateway_token_000000000";
const NOW = Date.parse("2026-03-01T12:00:00Z");

interface Answer {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

let clients = 0;

function gatewayWith(answer: (url: string, headers: Record<string, string>) => Answer, extra: { snapshot?: PrSnapshot; now?: () => number; memoryPaths?: number } = {}) {
  const urls: string[] = [];
  const lines: GhCallLine[] = [];
  const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    urls.push(url);
    const { status, body, headers = {} } = answer(url, Object.fromEntries(new Headers(init.headers).entries()));
    return new Response(body === undefined || status === 304 ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  }) as typeof globalThis.fetch;
  const client = octokitClient({ fetch, token: async () => TOKEN, throttleId: `gateway-${++clients}` });
  const gateway = ghGateway({ client, now: extra.now ?? (() => NOW), onCall: (line) => lines.push(line), ...(extra.snapshot && { snapshot: extra.snapshot }), ...(extra.memoryPaths !== undefined && { memoryPaths: extra.memoryPaths }) });
  return { gateway, urls, lines };
}

const command = (name: string) => GH_GATEWAY_COMMANDS.find((cmd) => cmd.name === name)!;
const contextWith = (gateway?: ReturnType<typeof ghGateway>) => partialFake<FactoryContext>({ shepherd: partialFake<ShepherdServices>(gateway ? { gateway } : {}) });

describe("shepherd.ghRead", () => {
  it("reads a whitelisted route and logs the real call with its caller", async () => {
    const { gateway, urls, lines } = gatewayWith(() => ({ status: 200, body: { id: 7 } }));

    const answer = await gateway.read({ path: "repos/octo/demo/actions/runs/7", caller: "gh-shim" });

    expect(answer).toEqual({ status: 200, body: { id: 7 }, at: new Date(NOW).toISOString(), stale: false, source: "github" });
    expect(urls).toEqual([`${API}repos/octo/demo/actions/runs/7`]);
    expect(lines).toEqual([{ v: 1, at: new Date(NOW).toISOString(), caller: "gh-shim", method: "GET", route: "repos/{owner}/{repo}/actions/runs/{id}", status: 200 }]);
  });

  it.each([
    "repos/octo/demo/pulls/1/merge",
    "repos/octo/demo/contents/README.md",
    "user",
    "repos/octo/demo/pulls?state=open&evil=1",
    "repos/octo/demo/actions/runs",
    "repos/../demo/pulls/1",
    "https://elsewhere.example/repos/octo/demo",
    "repos/octo/demo/commits/main/check-runs",
  ])("refuses %s, a route outside the whitelist, with no call", async (path) => {
    const { gateway, urls } = gatewayWith(() => ({ status: 200, body: {} }));

    await expect(gateway.read({ path })).rejects.toMatchObject({ code: EXIT.NOPERM });
    expect(urls).toEqual([]);
  });

  it("refuses any method but GET over the RPC, with no call", async () => {
    const { gateway, urls } = gatewayWith(() => ({ status: 200, body: {} }));

    for (const method of ["POST", "PUT", "PATCH", "DELETE", "HEAD"]) {
      const attempt = command("shepherd.ghRead").run({ path: "repos/octo/demo", method, caller: "t" }, contextWith(gateway));
      await expect(attempt).rejects.toMatchObject({ code: EXIT.NOPERM });
    }
    expect(urls).toEqual([]);
  });

  it("serves a 304 from the ETag cache", async () => {
    const { gateway, urls } = gatewayWith((_url, headers) => (headers["if-none-match"] === '"e1"' ? { status: 304 } : { status: 200, body: { full_name: "octo/demo" }, headers: { etag: '"e1"' } }));

    await gateway.read({ path: "repos/octo/demo" });
    const again = await gateway.read({ path: "repos/octo/demo" });

    expect(again).toMatchObject({ status: 200, body: { full_name: "octo/demo" }, stale: false });
    expect(urls).toHaveLength(2);
  });

  it("answers within maxAgeMs from memory with no call", async () => {
    let now = NOW;
    const { gateway, urls } = gatewayWith(() => ({ status: 200, body: { n: 1 } }), { now: () => now });

    await gateway.read({ path: "repos/octo/demo/pulls/3/files?per_page=100" });
    now += 5_000;
    const cached = await gateway.read({ path: "repos/octo/demo/pulls/3/files?per_page=100", maxAgeMs: 10_000 });

    expect(cached).toMatchObject({ body: { n: 1 }, at: new Date(NOW).toISOString(), source: "memory", stale: false });
    expect(urls).toHaveLength(1);
  });

  it("forgets the oldest path past its memory cap, so memory stays bounded", async () => {
    const { gateway, urls } = gatewayWith(() => ({ status: 200, body: {} }), { memoryPaths: 2 });
    const path = (id: number) => `repos/octo/demo/actions/runs/${id}`;

    for (const id of [1, 2, 3]) await gateway.read({ path: path(id) });
    await gateway.read({ path: path(3), maxAgeMs: 60_000 });
    await gateway.read({ path: path(1), maxAgeMs: 60_000 });

    expect(urls.map((url) => url.split("/").pop())).toEqual(["1", "2", "3", "1"]);
  });

  it("makes one request for two concurrent reads of one path", async () => {
    const { gateway, urls } = gatewayWith(() => ({ status: 200, body: { check_runs: [] } }));
    const path = `repos/octo/demo/commits/${"a".repeat(40)}/check-runs`;

    const [first, second] = await Promise.all([gateway.read({ path }), gateway.read({ path })]);

    expect(first).toEqual(second);
    expect(urls).toHaveLength(1);
  });

  it("answers a 404 as a status, not a failure", async () => {
    const { gateway } = gatewayWith(() => ({ status: 404, body: { message: "Not Found" } }));

    expect(await gateway.read({ path: "repos/octo/demo/pulls/99" })).toMatchObject({ status: 404, body: null, stale: false });
  });

  it("serves the last answer as stale when GitHub refuses, and refuses with no last answer", async () => {
    let limited = false;
    const secondary = { status: 403, body: { message: "You have exceeded a secondary rate limit." }, headers: { "retry-after": "120" } };
    const { gateway, urls } = gatewayWith(() => (limited ? secondary : { status: 200, body: { id: 1 } }));

    await gateway.read({ path: "repos/octo/demo/actions/runs/1" });
    limited = true;
    const stale = await gateway.read({ path: "repos/octo/demo/actions/runs/1" });
    const cooled = await gateway.read({ path: "repos/octo/demo/actions/runs/1" });
    const unknown = gateway.read({ path: "repos/octo/demo/actions/runs/2" });

    expect(stale).toMatchObject({ status: 200, body: { id: 1 }, stale: true });
    expect(cooled).toMatchObject({ stale: true });
    await expect(unknown).rejects.toMatchObject({ code: EXIT.TEMPFAIL });
    expect(urls).toHaveLength(2);
  });

  it("serves an open pull from the snapshot with no client call", async () => {
    const row = partialFake<PullRequest>({ number: 5, state: "open", headSha: "h".repeat(40) });
    const snapshot = partialFake<PrSnapshot>({ openPrs: async () => [row] });
    const { gateway, urls } = gatewayWith(() => ({ status: 200, body: {} }), { snapshot });

    const answer = await gateway.read({ path: "repos/octo/demo/pulls/5" });

    expect(answer).toMatchObject({ status: 200, body: row, source: "snapshot", stale: false });
    expect(urls).toEqual([]);
  });

  it("reads an open pull live as GitHub JSON when raw is set, though the snapshot holds it", async () => {
    const pull = { number: 5, head: { sha: "g".repeat(40) } };
    const { gateway, urls, lines } = gatewayWith(() => ({ status: 200, body: pull }), { snapshot: snapshotHoldingPull5() });

    const answer = await gateway.read({ path: "repos/octo/demo/pulls/5", raw: true, caller: "gh-shim" });

    expect(answer).toEqual({ status: 200, body: pull, at: new Date(NOW).toISOString(), stale: false, source: "github" });
    expect(urls).toEqual([`${API}repos/octo/demo/pulls/5`]);
    expect(lines).toEqual([{ v: 1, at: new Date(NOW).toISOString(), caller: "gh-shim", method: "GET", route: "repos/{owner}/{repo}/pulls/{n}", status: 200 }]);
  });

  it("passes raw through the RPC args to the gateway", async () => {
    const { gateway, urls } = gatewayWith(() => ({ status: 200, body: { number: 5 } }), { snapshot: snapshotHoldingPull5() });
    const ghRead = command("shepherd.ghRead");

    const answer = await ghRead.run(ghRead.args.parse({ path: "repos/octo/demo/pulls/5", raw: true, caller: "t" }), contextWith(gateway));

    expect(answer).toMatchObject({ body: { number: 5 }, source: "github" });
    expect(urls).toHaveLength(1);
  });
});

function snapshotHoldingPull5(): PrSnapshot {
  const row = partialFake<PullRequest>({ number: 5, state: "open", headSha: "h".repeat(40) });
  return partialFake<PrSnapshot>({ openPrs: async () => [row] });
}

describe("shepherd.ghBudget", () => {
  it("reports the gateway client's live rate window and cooldowns", async () => {
    const reset = Math.floor(NOW / 1000) + 900;
    const { gateway } = gatewayWith(() => ({ status: 200, body: {}, headers: { "x-ratelimit-resource": "core", "x-ratelimit-limit": "5000", "x-ratelimit-remaining": "4999", "x-ratelimit-used": "1", "x-ratelimit-reset": String(reset) } }));

    await gateway.read({ path: "repos/octo/demo" });
    const budget = await command("shepherd.ghBudget").run({}, contextWith(gateway));

    expect(budget).toEqual({ lanes: { rest: { limit: 5000, remaining: 4999, used: 1, resetAt: reset * 1000 } }, cooldowns: [] });
  });

  it("is unavailable on a host opened without the gateway", async () => {
    await expect(command("shepherd.ghBudget").run({}, contextWith())).rejects.toMatchObject({ code: EXIT.UNAVAILABLE });
  });
});
