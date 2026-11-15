import { describe, expect, it } from "vitest";
import type { GhExec, GhResult } from "./exec.js";
import { fakeGitHub, fakeSha } from "./fake.js";
import { API, fakeFetch } from "./fetch-fake.test-helpers.js";
import { ghCliWire } from "./gh-cli.js";
import { octokitClient } from "./octokit-client.js";
import { octokitWire } from "./octokit-wire.js";
import { PrOutcomeMalformed } from "./pr-outcome.js";
import { githubPort } from "./port.js";

const REPO = "octo/demo";

function pullRequest(fields: object): { data: { repository: { pullRequest: object } } } {
  const empty = { pageInfo: { hasNextPage: false }, nodes: [] };
  return { data: { repository: { pullRequest: { state: "OPEN", mergedAt: null, closedAt: null, reviews: empty, commits: empty, ...fields } } } };
}

function throughGh(body: unknown): { port: ReturnType<typeof githubPort>; calls: { args: readonly string[]; input?: string }[] } {
  const calls: { args: readonly string[]; input?: string }[] = [];
  const exec: GhExec = async (args, input) => (calls.push({ args, input }), { code: 0, stdout: JSON.stringify(body), stderr: "" } satisfies GhResult);
  return { port: githubPort(ghCliWire(exec)), calls };
}

const commit = (committedDate: string | null) => ({ commit: { committedDate } });

describe("reading a PR's outcome through gh", () => {
  it("answers a merged PR's merge and close times, review times and commit dates in one GraphQL call", async () => {
    const { port, calls } = throughGh(pullRequest({
      state: "MERGED", mergedAt: "2026-03-02T10:00:00Z", closedAt: "2026-03-02T10:00:00Z",
      reviews: { pageInfo: { hasNextPage: false }, nodes: [{ state: "APPROVED", submittedAt: "2026-03-02T09:30:00Z" }] },
      commits: { pageInfo: { hasNextPage: false }, nodes: [commit("2026-03-01T08:00:00Z"), commit("2026-03-01T09:00:00Z")] },
    }));

    const outcome = await port.readPrOutcome(REPO, 7);

    expect(outcome).toEqual({
      state: "merged", mergedAt: "2026-03-02T10:00:00Z", closedAt: "2026-03-02T10:00:00Z",
      reviews: [{ state: "APPROVED", submittedAt: "2026-03-02T09:30:00Z" }],
      commitDates: ["2026-03-01T08:00:00Z", "2026-03-01T09:00:00Z"], truncated: false,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args.slice(0, 5)).toEqual(["api", "-i", "-X", "POST", "graphql"]);
    expect(JSON.parse(calls[0]!.input!).variables).toEqual({ owner: "octo", name: "demo", number: 7 });
  });

  it("answers a PR closed without merging with a close time and no merge time", async () => {
    const { port } = throughGh(pullRequest({ state: "CLOSED", closedAt: "2026-03-03T12:00:00Z" }));

    await expect(port.readPrOutcome(REPO, 8)).resolves.toMatchObject({ state: "closed", mergedAt: null, closedAt: "2026-03-03T12:00:00Z" });
  });

  it("answers an open PR with its reviews, a pending one having no submit time", async () => {
    const { port } = throughGh(pullRequest({
      reviews: { pageInfo: { hasNextPage: false }, nodes: [{ state: "CHANGES_REQUESTED", submittedAt: "2026-03-04T01:00:00Z" }, { state: "PENDING", submittedAt: null }] },
    }));

    const outcome = await port.readPrOutcome(REPO, 9);

    expect(outcome).toMatchObject({ state: "open", mergedAt: null, closedAt: null });
    expect(outcome.reviews).toEqual([{ state: "CHANGES_REQUESTED", submittedAt: "2026-03-04T01:00:00Z" }, { state: "PENDING", submittedAt: null }]);
  });

  it("answers null for a commit whose committed date GitHub did not report", async () => {
    const { port } = throughGh(pullRequest({ commits: { pageInfo: { hasNextPage: false }, nodes: [commit(null), commit("2026-03-01T09:00:00Z")] } }));

    await expect(port.readPrOutcome(REPO, 7)).resolves.toMatchObject({ commitDates: [null, "2026-03-01T09:00:00Z"] });
  });

  it("flags a list cut at one page as truncated", async () => {
    const { port } = throughGh(pullRequest({ reviews: { pageInfo: { hasNextPage: true }, nodes: [] } }));

    await expect(port.readPrOutcome(REPO, 7)).resolves.toMatchObject({ truncated: true });
  });

  it("throws PrOutcomeMalformed, naming the field, when the state is not one GitHub defines", async () => {
    const { port } = throughGh(pullRequest({ state: "ARCHIVED" }));

    const error = await port.readPrOutcome(REPO, 7).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PrOutcomeMalformed);
    expect(error).toMatchObject({ name: "PrOutcomeMalformed", message: expect.stringContaining("state") });
  });

  it("throws PrOutcomeMalformed when a review lacks its state", async () => {
    const { port } = throughGh(pullRequest({ reviews: { pageInfo: { hasNextPage: false }, nodes: [{ submittedAt: null }] } }));

    await expect(port.readPrOutcome(REPO, 7)).rejects.toMatchObject({ name: "PrOutcomeMalformed" });
  });

  it("throws PrOutcomeMalformed when the pull request is not an object", async () => {
    const { port } = throughGh({ data: { repository: { pullRequest: "nope" } } });

    await expect(port.readPrOutcome(REPO, 7)).rejects.toMatchObject({ name: "PrOutcomeMalformed" });
  });

  it("throws GraphQL's own message when the PR cannot be resolved", async () => {
    const { port } = throughGh({ data: { repository: { pullRequest: null } }, errors: [{ message: "Could not resolve to a PullRequest" }] });

    await expect(port.readPrOutcome(REPO, 7)).rejects.toThrow(/Could not resolve to a PullRequest/);
  });
});

describe("reading a PR's outcome through the octokit wire", () => {
  it("posts the same GraphQL query and answers the same outcome", async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 200, body: pullRequest({ state: "CLOSED", closedAt: "2026-03-03T12:00:00Z", commits: { pageInfo: { hasNextPage: false }, nodes: [commit("2026-03-01T08:00:00Z")] } }) }));
    const client = octokitClient({ fetch, token: async () => "ghp_synthetic_outcome_token_0000000000", throttleId: "pr-outcome" });

    const outcome = await githubPort(octokitWire({ client })).readPrOutcome(REPO, 8);

    expect(outcome).toMatchObject({ state: "closed", closedAt: "2026-03-03T12:00:00Z", commitDates: ["2026-03-01T08:00:00Z"] });
    expect(calls[0]).toMatchObject({ method: "POST", url: `${API}graphql` });
  });
});

describe("a PR's outcome on the fake", () => {
  it("answers the seeded outcome, and a copy a caller cannot use to change it", async () => {
    const fake = fakeGitHub();
    fake.outcomes.set(3, { state: "merged", mergedAt: "2026-03-02T10:00:00Z", closedAt: "2026-03-02T10:00:00Z", reviews: [{ state: "APPROVED", submittedAt: "2026-03-02T09:00:00Z" }], commitDates: ["2026-03-01T08:00:00Z"], truncated: false });
    const port = githubPort(fake.wire);

    const first = await port.readPrOutcome(REPO, 3);
    first.reviews.length = 0;

    await expect(port.readPrOutcome(REPO, 3)).resolves.toMatchObject({ state: "merged", reviews: [{ state: "APPROVED" }] });
  });

  it("answers an unseeded PR from its own state, with no reviews or commit dates", async () => {
    const fake = fakeGitHub();
    const open = fake.addPr({ headSha: fakeSha("o") });
    const merged = fake.addPr({ headSha: fakeSha("m"), state: "closed", merged: true });

    await expect(githubPort(fake.wire).readPrOutcome(REPO, open.number)).resolves.toMatchObject({ state: "open", mergedAt: null, reviews: [], commitDates: [] });
    await expect(githubPort(fake.wire).readPrOutcome(REPO, merged.number)).resolves.toMatchObject({ state: "merged", mergedAt: merged.mergedAt });
  });

  it("throws 404 for a PR the fake lacks", async () => {
    await expect(githubPort(fakeGitHub().wire).readPrOutcome(REPO, 99)).rejects.toMatchObject({ status: 404 });
  });
});
