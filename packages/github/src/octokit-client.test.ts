import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeFetch, secondaryLimit, type FakeAnswer } from "./fetch-fake.test-helpers.js";
import { octokitClient } from "./octokit-client.js";

const TOKEN = "ghp_synthetic_test_token_0000000000";
const NOW = Date.parse("2026-03-01T12:00:00Z");
const ok: FakeAnswer = { status: 200, body: { ok: true } };

let clients = 0;

/** Each client gets its own throttle key: the throttle's limiters are per process, and fake time must not leak between tests. */
function clientWith(answer: (index: number) => FakeAnswer, token: () => Promise<string> = async () => TOKEN) {
  const fake = fakeFetch((_call, index) => answer(index));
  return { ...fake, client: octokitClient({ fetch: fake.fetch, token, now: Date.now, throttleId: `test-${++clients}` }) };
}

/** Lets the throttle's and retry's timers run under fake time. */
async function settle<T>(pending: Promise<T>, ms = 5_000): Promise<T> {
  const caught = pending.catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(ms);
  const result = await caught;
  if (result instanceof Error) throw result;
  return result as T;
}

describe("octokitClient", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends the token as a bearer header, never in the URL", async () => {
    const { client, calls } = clientWith(() => ok);

    await settle(client.request("GET /repos/{owner}/{repo}", { owner: "octo", repo: "demo" }));

    expect(calls[0]!.headers.authorization).toBe(`bearer ${TOKEN}`);
    expect(calls[0]!.url).not.toContain(TOKEN);
  });

  it("waits out a secondary limit's retry-after on a GET and retries it once", async () => {
    const { client, calls } = clientWith((index) => (index === 0 ? secondaryLimit("5") : ok));

    const pending = client.request("GET /repos/octo/demo");
    await vi.advanceTimersByTimeAsync(4_900);
    expect(calls).toHaveLength(1);
    const response = await settle(pending, 200);

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(2);
  });

  it("never retries a write on a secondary limit", async () => {
    const { client, calls } = clientWith(() => secondaryLimit("5"));

    const attempt = settle(client.request("PUT /repos/octo/demo/pulls/1/merge", { sha: "abc" }), 120_000);

    await expect(attempt).rejects.toMatchObject({ status: 403 });
    expect(calls).toHaveLength(1);
  });

  it("fails a GET whose retry-after is past a minute rather than wait", async () => {
    const { client, calls } = clientWith(() => secondaryLimit("120"));

    await expect(settle(client.request("GET /repos/octo/demo"), 300_000)).rejects.toMatchObject({ status: 403 });
    expect(calls).toHaveLength(1);
  });

  it("retries a GET that answers 500, and never a POST", async () => {
    const read = clientWith((index) => (index === 0 ? { status: 500, body: { message: "boom" } } : ok));
    const write = clientWith(() => ({ status: 500, body: { message: "boom" } }));

    const response = await settle(read.client.request("GET /repos/octo/demo"), 10_000);
    const posted = settle(write.client.request("POST /repos/octo/demo/issues/1/comments", { body: "hi" }), 60_000);

    expect(response.status).toBe(200);
    expect(read.calls).toHaveLength(2);
    await expect(posted).rejects.toMatchObject({ status: 500 });
    expect(write.calls).toHaveLength(1);
  });

  it("re-reads the token once on a 401", async () => {
    const tokens = vi.fn<() => Promise<string>>().mockResolvedValueOnce("ghp_stale_synthetic").mockResolvedValue(TOKEN);
    const { client, calls } = clientWith((index) => (index === 0 ? { status: 401, body: { message: "Bad credentials" } } : ok), tokens);

    const response = await settle(client.request("GET /user"));

    expect(response.status).toBe(200);
    expect(tokens).toHaveBeenCalledTimes(2);
    expect(calls.map((call) => call.headers.authorization)).toEqual(["bearer ghp_stale_synthetic", `bearer ${TOKEN}`]);
  });

  it("gives up after one re-read when the fresh token is refused too", async () => {
    const tokens = vi.fn(async () => TOKEN);
    const { client, calls } = clientWith(() => ({ status: 401, body: { message: "Bad credentials" } }), tokens);

    await expect(settle(client.request("GET /user"))).rejects.toMatchObject({ status: 401 });
    expect(calls).toHaveLength(2);
    expect(tokens).toHaveBeenCalledTimes(2);
  });

  it("keeps the token out of a failure's message and its request headers", async () => {
    const { client } = clientWith(() => ({ status: 403, body: { message: `Resource not accessible with ${TOKEN}` } }));

    const error = await settle(client.request("POST /repos/octo/demo/check-runs", { name: "x" })).catch((caught: unknown) => caught);

    expect(JSON.stringify(error)).not.toContain(TOKEN);
    expect(String((error as Error).message)).not.toContain(TOKEN);
    expect((error as Error).stack ?? "").not.toContain(TOKEN);
  });

  it("reports the live rate window and a secondary-limit cooldown in its budget", async () => {
    const reset = Math.floor(NOW / 1000) + 600;
    const { client } = clientWith((index) =>
      index === 0 ? { ...ok, headers: { "x-ratelimit-resource": "core", "x-ratelimit-limit": "5000", "x-ratelimit-remaining": "4321", "x-ratelimit-used": "679", "x-ratelimit-reset": String(reset) } } : secondaryLimit("30"),
    );

    await settle(client.request("GET /repos/octo/demo"));
    await settle(client.request("POST /graphql", { query: "{ viewer { login } }" }), 1_000).catch(() => undefined);
    const budget = client.budget();

    expect(budget.lanes.rest).toEqual({ limit: 5000, remaining: 4321, used: 679, resetAt: reset * 1000 });
    expect(budget.cooldowns).toEqual([{ lane: "graphql", class: "secondary", until: expect.any(Number) }]);
    expect(budget.cooldowns[0]!.until - Date.now()).toBeGreaterThan(28_000);
  });

  it("drops a cooldown from the budget once it has passed", async () => {
    const { client } = clientWith(() => secondaryLimit("5"));

    await settle(client.request("POST /repos/octo/demo/issues/1/comments", { body: "x" }), 1_000).catch(() => undefined);
    expect(client.budget().cooldowns).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(6_000);

    expect(client.budget().cooldowns).toEqual([]);
  });
});
