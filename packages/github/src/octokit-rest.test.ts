import { describe, expect, it } from "vitest";
import { GhError } from "./exec.js";
import { API, fakeFetch, type FakeAnswer, type FetchCall } from "./fetch-fake.test-helpers.js";
import { octokitClient } from "./octokit-client.js";
import { octokitRest } from "./octokit-rest.js";

const TOKEN = "ghp_synthetic_rest_token_000000000000";
let clients = 0;

function restWith(answer: (call: FetchCall, index: number) => FakeAnswer) {
  const fake = fakeFetch(answer);
  const client = octokitClient({ fetch: fake.fetch, token: async () => TOKEN, throttleId: `rest-${++clients}` });
  return { ...fake, api: octokitRest(client, 10) };
}

const page = (body: unknown, headers: Record<string, string> = {}): FakeAnswer => ({ status: 200, body, headers });

describe("octokitRest", () => {
  it("reads a GET with its fields as the query", async () => {
    const { api, calls } = restWith(() => page({ default_branch: "main" }));

    const body = await api.get<{ default_branch: string }>("repos/octo/demo/branches", { per_page: "1", protected: "true" });

    expect(body).toEqual({ default_branch: "main" });
    expect(calls[0]).toMatchObject({ method: "GET", url: `${API}repos/octo/demo/branches?per_page=1&protected=true` });
  });

  it("keeps an owner:branch head in a raw path intact, never expanded as a URL template", async () => {
    const { api, calls } = restWith(() => page([]));

    await api.get("repos/octo/demo/pulls?head=octo:feat-x&state=open");
    await api.get("repos/octo/demo/pulls", { head: "octo:feat-y" });

    const heads = calls.map((call) => new URL(call.url).searchParams.get("head"));
    expect(heads).toEqual(["octo:feat-x", "octo:feat-y"]);
  });

  it("sends the cached ETag and answers a 304 with the cached body", async () => {
    const { api, calls } = restWith((_call, index) => (index === 0 ? page({ n: 1 }, { etag: '"v1"' }) : { status: 304 }));

    const first = await api.get("repos/octo/demo");
    const second = await api.get("repos/octo/demo");

    expect(second).toEqual(first);
    expect(calls[0]!.headers["if-none-match"]).toBeUndefined();
    expect(calls[1]!.headers["if-none-match"]).toBe('"v1"');
  });

  it("refuses a 304 to a request it sent unconditionally", async () => {
    const { api } = restWith(() => ({ status: 304 }));

    await expect(api.get("repos/octo/demo")).rejects.toThrow(/304 to an unconditional request/);
  });

  it("follows two Link pages, each conditional on its own ETag", async () => {
    const next = (n: number) => `<${API}repositories/1/pulls?page=${n}>; rel="next"`;
    const { api, calls } = restWith((call) => {
      if (call.url.endsWith("page=3")) return page([3], { etag: '"p3"' });
      if (call.url.endsWith("page=2")) return page([2], { etag: '"p2"', link: next(3) });
      return page([1], { etag: '"p1"', link: next(2) });
    });

    const items = await api.pages("repos/octo/demo/pulls", { per_page: "100" }, (body: number[]) => body);
    await api.pages("repos/octo/demo/pulls", { per_page: "100" }, (body: number[]) => body);

    expect(items).toEqual([1, 2, 3]);
    expect(calls.slice(3).map((call) => call.headers["if-none-match"])).toEqual(['"p1"', '"p2"', '"p3"']);
  });

  it("refuses a next page off the API origin", async () => {
    const { api } = restWith(() => page([1], { link: '<https://elsewhere.example/p?page=2>; rel="next"' }));

    await expect(api.pages("repos/octo/demo/pulls", {}, (body: number[]) => body)).rejects.toThrow(/refusing to follow a next page/);
  });

  it("revalidates a list on the caller's ETag: 304 is not modified, 200 carries the new ETag", async () => {
    const { api, calls } = restWith((call) => (call.headers["if-none-match"] === '"old"' ? { status: 304 } : page([{ n: 1 }], { etag: '"new"' })));

    const unchanged = await api.revalidatePages("repos/octo/demo/pulls", { state: "open" }, '"old"', (body: unknown[]) => body);
    const changed = await api.revalidatePages("repos/octo/demo/pulls", { state: "open" }, null, (body: unknown[]) => body);

    expect(unchanged).toEqual({ notModified: true });
    expect(changed).toEqual({ notModified: false, body: [{ n: 1 }], etag: '"new"' });
    expect(calls[1]!.headers["if-none-match"]).toBeUndefined();
  });

  it("answers null on a 404 from getOrNull and a GhError with the status otherwise", async () => {
    const { api } = restWith((call) => (call.url.includes("missing") ? { status: 404, body: { message: "Not Found" } } : { status: 422, body: { message: "No commit found" } }));

    const missing = await api.getOrNull("repos/octo/demo/contents/missing");
    const error = await api.get("repos/octo/demo/commits/abc").catch((caught: unknown) => caught);

    expect(missing).toBeNull();
    expect(error).toBeInstanceOf(GhError);
    expect((error as GhError).status).toBe(422);
    expect((error as GhError).message).toContain("No commit found");
  });

  it("posts a GraphQL query as the raw input body", async () => {
    const { api, calls } = restWith(() => page({ data: { viewer: { login: "octo" } } }));
    const input = JSON.stringify({ query: "{ viewer { login } }", variables: {} });

    const answer = await api.send("POST", "graphql", {}, input);

    expect(answer).toEqual({ data: { viewer: { login: "octo" } } });
    expect(calls[0]).toMatchObject({ method: "POST", url: `${API}graphql`, body: input });
  });

  it("sends a write's fields as its JSON body, and with an input as its query", async () => {
    const fields = restWith(() => page({ sha: "m1" }));
    const input = restWith(() => page({ id: 1 }));

    await fields.api.send("PUT", "repos/octo/demo/pulls/1/merge", { sha: "h1", merge_method: "squash" });
    await input.api.send("POST", "repos/octo/demo/check-runs", { draft: "1" }, '{"name":"x"}');

    expect(fields.calls[0]).toMatchObject({ method: "PUT", url: `${API}repos/octo/demo/pulls/1/merge` });
    expect(JSON.parse(fields.calls[0]!.body!)).toEqual({ sha: "h1", merge_method: "squash" });
    expect(input.calls[0]).toMatchObject({ url: `${API}repos/octo/demo/check-runs?draft=1`, body: '{"name":"x"}' });
  });

  it("reads a body that is not JSON as text", async () => {
    const { api } = restWith(() => ({ status: 200, body: "line one\nline two" }));

    expect(await api.text("repos/octo/demo/actions/jobs/9/logs")).toBe("line one\nline two");
  });

  it("keeps the token out of a failure", async () => {
    const { api } = restWith(() => ({ status: 403, body: { message: `denied for ${TOKEN}` } }));

    const error = await api.send("POST", "repos/octo/demo/issues/1/comments", {}, "{}").catch((caught: unknown) => caught);

    expect((error as GhError).status).toBe(403);
    expect(JSON.stringify(error) + (error as Error).message).not.toContain(TOKEN);
  });
});
