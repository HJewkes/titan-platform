import { afterEach, describe, expect, it, vi } from "vitest";
import { rateBudget } from "./budget.js";
import { GhError, type GhExec, type GhResult } from "./exec.js";
import { fakeFetch, rejectionOf, type FakeAnswer } from "./fetch-fake.test-helpers.js";
import { redactedError } from "./gh-cli.js";
import { octokitClient } from "./octokit-client.js";
import { octokitRest } from "./octokit-rest.js";
import { CORE_TIMEOUT_MS, restCaller } from "./rest.js";

const TOKEN = "ghp_synthetic_transport_token_00000000";
let clients = 0;

/** A `gh api` that always prints `result`; reads are retried with no wait, so each call ends on the same result. */
const ghRest = (result: GhResult) => restCaller((async () => result) satisfies GhExec, rateBudget(), 0, async () => undefined);
const ghAnswered = (status: number, stderr: string): GhResult => ({ code: 1, stdout: `HTTP/2.0 ${status} X\r\n\r\n{}`, stderr });
const ghUnanswered = (stderr: string, stdout = ""): GhResult => ({ code: 1, stdout, stderr });

const octokitRestOver = (fetch: typeof globalThis.fetch) => octokitRest(octokitClient({ fetch, token: async () => TOKEN, throttleId: `transport-${++clients}` }));
const answering = (answer: FakeAnswer) => octokitRestOver(fakeFetch(() => answer).fetch);

/** A socket that never answers, aborting the way undici does once the deadline's signal fires. */
const hungFetch = (async (_input: string | URL | Request, init: RequestInit = {}) =>
  new Promise<Response>((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))))) as typeof globalThis.fetch;

/** A connection refused before any HTTP answer, shaped as Node's `fetch` reports it. */
const refusedFetch = (async () => {
  throw new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED 192.0.2.1:443") });
}) as typeof globalThis.fetch;

const transportOf = async (pending: Promise<unknown>) => (await rejectionOf(pending, GhError)).transport;

async function afterDeadline(pending: Promise<unknown>) {
  const transport = transportOf(pending);
  await vi.advanceTimersByTimeAsync(CORE_TIMEOUT_MS + 1_000);
  return transport;
}

describe("GhError.transport over gh api", () => {
  it("is server-5xx when GitHub answered a 5xx", async () => {
    expect(await transportOf(ghRest(ghAnswered(502, "gh: Bad Gateway (HTTP 502)")).get("repos/octo/demo"))).toBe("server-5xx");
  });

  it("is no-connection when gh could not reach GitHub", async () => {
    const said = ghUnanswered("error connecting to api.github.com\ncheck your internet connection");

    expect(await transportOf(ghRest(said).send("POST", "repos/octo/demo/issues/1/comments"))).toBe("no-connection");
  });

  it("is empty-or-cut-body when gh printed nothing or met a cut-off body", async () => {
    expect(await transportOf(ghRest(ghUnanswered("")).send("PUT", "repos/octo/demo/pulls/1/update-branch"))).toBe("empty-or-cut-body");
    expect(await transportOf(ghRest(ghUnanswered("unexpected end of JSON input")).get("repos/octo/demo"))).toBe("empty-or-cut-body");
  });

  it("is none for an answer GitHub meant, even when its text reads like a server failure", async () => {
    expect(await transportOf(ghRest(ghAnswered(404, "gh: Not Found (HTTP 404)")).get("repos/octo/demo"))).toBe("none");
    expect(await transportOf(ghRest(ghAnswered(422, "unexpected end of JSON input")).send("PUT", "repos/octo/demo/pulls/1/merge"))).toBe("none");
  });

  it("survives the redaction a token-scoped call rebuilds its error with", () => {
    const failed = new GhError(["api", "repos/octo/demo"], ghUnanswered(`error connecting with ${TOKEN}`), undefined, "", "no-connection");

    const rebuilt = redactedError(failed, [TOKEN]);

    expect(rebuilt).toBeInstanceOf(GhError);
    expect(rebuilt).toMatchObject({ transport: "no-connection" });
  });
});

describe("GhError.transport over Octokit", () => {
  afterEach(() => void vi.useRealTimers());

  it("is server-5xx when GitHub answered a 5xx", async () => {
    expect(await transportOf(answering({ status: 503, body: { message: "unavailable" } }).send("POST", "repos/octo/demo/issues/1/comments"))).toBe("server-5xx");
  });

  it("is no-connection when the connection failed before any answer", async () => {
    expect(await transportOf(octokitRestOver(refusedFetch).send("POST", "repos/octo/demo/issues/1/comments"))).toBe("no-connection");
  });

  it("is read-timeout when a GET hit the deadline", async () => {
    vi.useFakeTimers();

    expect(await afterDeadline(octokitRestOver(hungFetch).get("repos/octo/demo"))).toBe("read-timeout");
  });

  it("a timed-out write is not read-timeout, since it may have landed", async () => {
    vi.useFakeTimers();

    expect(await afterDeadline(octokitRestOver(hungFetch).send("PUT", "repos/octo/demo/pulls/1/merge"))).toBe("none");
  });

  it("is none for a 4xx GitHub meant", async () => {
    expect(await transportOf(answering({ status: 422, body: { message: "unprocessable" } }).send("POST", "repos/octo/demo/pulls"))).toBe("none");
  });
});
