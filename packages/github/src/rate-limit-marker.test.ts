import { describe, expect, it } from "vitest";
import { rateBudget } from "./budget.js";
import { GhError, type GhExec, type GhResult } from "./exec.js";
import { fakeFetch, rejectionOf, secondaryLimit, type FakeAnswer } from "./fetch-fake.test-helpers.js";
import { ghCliWire } from "./gh-cli.js";
import { octokitClient } from "./octokit-client.js";
import { octokitWire } from "./octokit-wire.js";
import { parseRateLimitMarker, rateLimitMarker } from "./rate-limit-marker.js";

const REPO = "octo/demo";
const TOKEN = "ghp_synthetic_marker_token_0000000000";
/** Far enough out that Octokit's throttle never holds the read itself. */
const RESET_S = String(Math.floor(Date.now() / 1000) + 3_000);
const PRIMARY_HEADERS = { "x-ratelimit-limit": "5000", "x-ratelimit-remaining": "0", "x-ratelimit-reset": RESET_S, "x-ratelimit-resource": "core" };
const PRIMARY_BODY = { message: "API rate limit exceeded for user ID 1.", documentation_url: "https://docs.github.com/rest/overview/rate-limits-for-the-rest-api" };

function ghAnswer(status: number, headers: Record<string, string>, body: unknown, stderr: string): GhResult {
  const head = Object.entries(headers).map(([name, value]) => `\r\n${name}: ${value}`).join("");
  return { code: 1, stdout: `HTTP/2.0 ${status} Forbidden${head}\r\n\r\n${JSON.stringify(body)}`, stderr };
}

// Each wire gets its own budget: a shared one would hold every later call until the limited answer's reset.
const cliWire = (result: GhResult) => ghCliWire((async () => result) satisfies GhExec, { sleep: async () => undefined, budget: rateBudget() });

let clients = 0;
function octokitWireAnswering(answer: FakeAnswer) {
  const fake = fakeFetch(() => answer);
  return octokitWire({ client: octokitClient({ fetch: fake.fetch, token: async () => TOKEN, throttleId: `marker-${++clients}`, budget: rateBudget() }) });
}

describe("rate-limit marker on the gh CLI transport", () => {
  it("marks a primary-limit 403 with its status, method and reset", async () => {
    const wire = cliWire(ghAnswer(403, PRIMARY_HEADERS, PRIMARY_BODY, "gh: API rate limit exceeded for user ID 1. (HTTP 403)\n"));

    const error = await rejectionOf(wire.getPr(REPO, 7), GhError);

    expect(parseRateLimitMarker(error.message)).toEqual({ status: 403, method: "GET", headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": RESET_S, "x-ratelimit-resource": "core" } });
    expect(error.status).toBe(403);
  });

  it("marks a 403 that names the limit only in its text", async () => {
    const wire = cliWire(ghAnswer(403, {}, { message: "API rate limit exceeded" }, "gh: API rate limit exceeded (HTTP 403)\n"));

    const error = await rejectionOf(wire.getPr(REPO, 7), GhError);

    expect(parseRateLimitMarker(error.message)).toMatchObject({ status: 403, method: "GET" });
  });

  it("leaves a 403 that is not a limit unmarked", async () => {
    const wire = cliWire(ghAnswer(403, { "x-ratelimit-remaining": "4000" }, { message: "Resource not accessible by integration" }, "gh: Resource not accessible by integration (HTTP 403)\n"));

    const error = await rejectionOf(wire.getPr(REPO, 7), GhError);

    expect(parseRateLimitMarker(error.message)).toBeUndefined();
  });

  it("names the write's method on a limited write", async () => {
    const wire = cliWire(ghAnswer(429, { "retry-after": "30" }, { message: "slow down" }, "gh: slow down (HTTP 429)\n"));

    const error = await rejectionOf(wire.createComment(REPO, 7, "hi"), GhError);

    expect(parseRateLimitMarker(error.message)).toMatchObject({ status: 429, method: "POST", headers: { "retry-after": "30" } });
  });
});

describe("rate-limit marker on the Octokit transport", () => {
  it("carries the same marker for a primary-limit 403", async () => {
    const wire = octokitWireAnswering({ status: 403, body: PRIMARY_BODY, headers: PRIMARY_HEADERS });

    const error = await rejectionOf(wire.getPr(REPO, 7), GhError);

    expect(parseRateLimitMarker(error.message)).toEqual({ status: 403, method: "GET", headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": RESET_S, "x-ratelimit-resource": "core" } });
  });

  it("carries the marker for a secondary limit past the throttle's own wait", async () => {
    const wire = octokitWireAnswering(secondaryLimit("120"));

    const error = await rejectionOf(wire.getPr(REPO, 7), GhError);

    expect(parseRateLimitMarker(error.message)).toMatchObject({ status: 403, method: "GET", headers: { "retry-after": "120" } });
  });

  it("leaves a 403 that is not a limit unmarked", async () => {
    const wire = octokitWireAnswering({ status: 403, body: { message: "Must have admin rights to Repository." }, headers: { "x-ratelimit-remaining": "4999" } });

    const error = await rejectionOf(wire.getPr(REPO, 7), GhError);

    expect(parseRateLimitMarker(error.message)).toBeUndefined();
  });
});

describe("rateLimitMarker", () => {
  it("drops a header value that is not a plain token, so a marker never carries free text", () => {
    const marker = rateLimitMarker(429, "GET", new Map([["retry-after", "30]; rm -rf"]]), "slow down");

    expect(marker).toBe("[gh-rate-limit status=429 method=GET]");
  });

  it("marks nothing for a 5xx, which the server-error retry owns", () => {
    expect(rateLimitMarker(502, "GET", new Map(), "rate limit")).toBe("");
  });
});
