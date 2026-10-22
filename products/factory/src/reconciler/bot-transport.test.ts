import { describe, expect, it } from "vitest";
import { GATE_KEYS, botTransport } from "./bot-transport.js";
import { REPO, fakeBotGithub } from "./fakes.test-helpers.js";
import type { BackstopCall } from "./service.js";

const gates = (etags: Record<string, string | null> = {}): BackstopCall => ({ kind: "gates", repo: REPO, etags });
const snapshot: BackstopCall = { kind: "snapshot", request: { repo: REPO, branch: "main", since: "2027-01-14T08:00:00Z", mainCursor: null, doneSince: "2027-01-14T08:00:00Z" } };
const CURRENT = { [GATE_KEYS.pulls]: '"pulls-1"', [GATE_KEYS.ref]: '"ref-1"', [GATE_KEYS.rulesets]: '"rulesets-1"' };

describe("bot transport gates (TP-3431)", () => {
  it("answers changed, with each read's ETag, when no earlier read vouches for anything", async () => {
    const github = fakeBotGithub();

    const answer = await botTransport(github.client)(gates());

    expect(answer).toMatchObject({ status: 200, gates: { changed: true, etags: CURRENT } });
  });

  it("answers unchanged and keeps the ETags when all three reads answer 304", async () => {
    const github = fakeBotGithub();

    const answer = await botTransport(github.client)(gates(CURRENT));

    expect(answer.gates).toEqual({ changed: false, etags: CURRENT, reads: 3, notModified: 3 });
    expect(github.requests.map((sent) => sent.ifNoneMatch)).toEqual(Object.values(CURRENT));
  });

  it("answers changed with the new ETag of the one read that changed", async () => {
    const github = fakeBotGithub();
    github.versions.ref = 2;

    const answer = await botTransport(github.client)(gates(CURRENT));

    expect(answer.gates).toEqual({ changed: true, etags: { ...CURRENT, [GATE_KEYS.ref]: '"ref-2"' }, reads: 3, notModified: 2 });
  });

  it("reads a free-plan repo's refused rulesets as unchanged, with no ETag to send next time", async () => {
    const github = fakeBotGithub();
    github.fail.set("rulesets", { status: 403, body: { message: "Upgrade to GitHub Pro or make this repository public to enable this feature." } });

    const answer = await botTransport(github.client)(gates(CURRENT));

    expect(answer.gates).toEqual({ changed: false, etags: { ...CURRENT, [GATE_KEYS.rulesets]: null }, reads: 3, notModified: 2 });
  });

  it("carries the ruleset list when it changed, for observe to diff", async () => {
    const github = fakeBotGithub();
    github.versions.rulesets = 2;

    const answer = await botTransport(github.client)(gates(CURRENT));

    expect(answer.gates).toEqual({
      changed: true,
      etags: { ...CURRENT, [GATE_KEYS.rulesets]: '"rulesets-2"' },
      reads: 3,
      notModified: 2,
      rulesets: { notModified: false, unreadable: false, rulesets: { 7: "2027-01-15T07:02:00Z" }, etag: '"rulesets-2"' },
    });
  });
});

describe("bot transport ancestry (TP-3431)", () => {
  const ancestry: BackstopCall = { kind: "ancestry", repo: REPO, base: "c0", head: "c1" };

  it("answers the guard's compare with GitHub's status", async () => {
    const github = fakeBotGithub();
    github.compare = "behind";

    const answer = await botTransport(github.client)(ancestry);

    expect(answer).toMatchObject({ status: 200, ancestry: "behind" });
    expect(github.requests.map((sent) => sent.route)).toEqual(["compare"]);
  });

  it("answers a limited compare's status for the pool, with no ancestry", async () => {
    const github = fakeBotGithub();
    github.fail.set("compare", { status: 403, body: { message: "You have exceeded a secondary rate limit." }, headers: { "retry-after": "60" } });

    const answer = await botTransport(github.client)(ancestry);

    expect(answer).toMatchObject({ status: 403, headers: { "retry-after": "60" } });
    expect(answer.ancestry).toBeUndefined();
  });
});

describe("bot transport snapshot (TP-3431)", () => {
  it("answers the snapshot read with its status", async () => {
    const github = fakeBotGithub();

    const answer = await botTransport(github.client)(snapshot);

    expect(answer.status).toBe(200);
    expect(answer.snapshot?.main).toMatchObject({ tip: "c1", commits: [{ oid: "c1" }] });
    expect(github.count("graphql")).toBe(1);
  });

  it("throws on a GraphQL error that names no limit, so the unit fails rather than the pool tripping", async () => {
    const github = fakeBotGithub();
    github.fail.set("graphql", { status: 200, body: { data: null, errors: [{ type: "NOT_FOUND", message: "Could not resolve to a Repository." }] } });

    await expect(botTransport(github.client)(snapshot)).rejects.toThrow(/Could not resolve/);
  });
});

describe("bot transport failures, for the pool to classify (TP-3431)", () => {
  it("answers GitHub's status, lower-cased headers and message, and no read", async () => {
    const github = fakeBotGithub();
    github.fail.set("pulls", { status: 403, body: { message: "You have exceeded a secondary rate limit." }, headers: { "Retry-After": "60" } });

    const answer = await botTransport(github.client)(gates(CURRENT));

    expect(answer).toMatchObject({ status: 403, headers: { "retry-after": "60" }, message: expect.stringMatching(/secondary rate limit/) });
    expect(answer.gates).toBeUndefined();
  });

  it("answers GraphQL's primary limit, a 200 naming it, as the 403 it stands for, with the response's headers", async () => {
    const github = fakeBotGithub();
    github.fail.set("graphql", { status: 200, body: { data: null, errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded for installation ID 1." }] }, headers: { "x-ratelimit-reset": "1800000000" } });

    const answer = await botTransport(github.client)(snapshot);

    expect(answer).toMatchObject({ status: 403, headers: { "x-ratelimit-reset": "1800000000" } });
    expect(answer.snapshot).toBeUndefined();
  });

  it("answers a network failure as one, with no status", async () => {
    const github = fakeBotGithub();
    github.fail.set("ref", "network");

    const answer = await botTransport(github.client)(gates(CURRENT));

    expect(answer).toMatchObject({ networkError: true, headers: {} });
    expect(answer.status).toBeUndefined();
  });
});
