import { describe, expect, it } from "vitest";
import { GhError } from "./exec.js";
import { fakeGitHub, fakeSha } from "./fake.js";
import { API, fakeFetch, rejectionOf, type FakeAnswer } from "./fetch-fake.test-helpers.js";
import { octokitClient } from "./octokit-client.js";
import { octokitWire } from "./octokit-wire.js";
import { githubPort } from "./port.js";
import { GitHubInputError } from "./validate.js";

const REPO = "octo/demo";
const TOKEN = "ghp_synthetic_merges_token_0000000000";
const TRAIN = "shepherd-train/1";
const HEAD = fakeSha("member");
const MERGED = fakeSha("merged");
let clients = 0;

function portAnswering(answer: FakeAnswer) {
  const fake = fakeFetch(() => answer);
  const client = octokitClient({ fetch: fake.fetch, token: async () => TOKEN, throttleId: `merges-${++clients}` });
  return { calls: fake.calls, port: githubPort(octokitWire({ client })) };
}

describe("mergeIntoBranch over the HTTP layer", () => {
  it.each([
    ["201 with the merge commit", { status: 201, body: { sha: MERGED } }, { outcome: "merged", sha: MERGED }],
    ["204, the head already in the branch", { status: 204 }, { outcome: "already-contained" }],
    ["409, a merge conflict", { status: 409, body: { message: "Merge conflict" } }, { outcome: "conflict" }],
  ])("reads %s", async (_case, answer, expected) => {
    const { port, calls } = portAnswering(answer);

    expect(await port.mergeIntoBranch(REPO, { branch: TRAIN, head: HEAD, message: "Batch 1" })).toEqual(expected);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "POST", url: `${API}repos/${REPO}/merges` });
    expect(JSON.parse(calls[0]!.body ?? "")).toEqual({ base: TRAIN, head: HEAD, commit_message: "Batch 1" });
  });

  it.each([404, 422, 500])("throws on %i, once, with the status kept", async (status) => {
    const { port, calls } = portAnswering({ status, body: { message: "refused" } });

    const error = await rejectionOf(port.mergeIntoBranch(REPO, { branch: TRAIN, head: HEAD }), GhError);

    expect([error.status, calls.length]).toEqual([status, 1]);
  });

  it("throws on a success body with no merge commit sha", async () => {
    const { port } = portAnswering({ status: 201, body: { message: "odd" } });

    await expect(port.mergeIntoBranch(REPO, { branch: TRAIN, head: HEAD })).rejects.toThrow(/no merge commit sha/);
  });
});

describe("mergeIntoBranch on the fake", () => {
  it("merges a member once, reads a repeat as contained, and leaves the branch alone on a conflict", async () => {
    const fake = fakeGitHub();
    fake.refs.set(TRAIN, fakeSha("base"));
    fake.mergeConflicts.add(fakeSha("clash"));
    const port = githubPort(fake.wire);

    const first = await port.mergeIntoBranch(REPO, { branch: TRAIN, head: HEAD });
    const tip = fake.refs.get(TRAIN);
    const again = await port.mergeIntoBranch(REPO, { branch: TRAIN, head: HEAD });
    const clash = await port.mergeIntoBranch(REPO, { branch: TRAIN, head: fakeSha("clash") });

    expect([first.outcome, again, clash]).toEqual(["merged", { outcome: "already-contained" }, { outcome: "conflict" }]);
    expect(fake.refs.get(TRAIN)).toBe(tip);
    expect(fake.commits.get(tip ?? "")?.parents).toEqual([fakeSha("base"), HEAD]);
  });

  it("validates the branch and head before any call", async () => {
    const fake = fakeGitHub();
    const port = githubPort(fake.wire);

    await expect(port.mergeIntoBranch(REPO, { branch: "../main", head: HEAD })).rejects.toBeInstanceOf(GitHubInputError);
    await expect(port.mergeIntoBranch(REPO, { branch: TRAIN, head: "not-a-sha" })).rejects.toBeInstanceOf(GitHubInputError);
    expect(fake.calls).toEqual([]);
  });
});
