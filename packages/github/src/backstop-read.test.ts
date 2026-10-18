import { describe, expect, it } from "vitest";
import { backstopApi, backstopOctokitApi, checkRun, emptyRepo, range, review, status, type FakeRepo } from "./backstop-fake.test-helpers.js";
import { BACKSTOP_CAPS, BackstopTruncated, graphqlPoints, readBackstopSnapshot, snapshotRequests, type BackstopRequest } from "./backstop-read.js";
import { fakeSha } from "./fake.js";
import { rejectionOf } from "./fetch-fake.test-helpers.js";

const REQUEST: BackstopRequest = { repo: "o/r", branch: "main", since: "2026-01-01T00:00:00Z", mainCursor: null, doneSince: "2026-01-01T00:00:00Z" };
const RECENT = "2026-01-02T00:00:00Z";

const openPrs = (count: number) => range(count).map((number) => ({ number, head: fakeSha(`head-${number}`), updatedAt: RECENT }));
const donePrs = (count: number, updatedAt = RECENT) => range(count).map((number) => ({ number, merged: true, mergedBy: { login: "octo" }, mergeCommit: { oid: fakeSha(`merge-${number}`) }, closedAt: updatedAt, updatedAt }));
const mainCommits = (count: number) => range(count).map((n) => fakeSha(`main-${n}`));

function repoWith(changes: Partial<FakeRepo>): FakeRepo {
  return { ...emptyRepo(), ...changes };
}

describe("reading a repo's backstop snapshot", () => {
  it("answers open PRs with head rollup and reviews, closed PRs, and main history in one query", async () => {
    const head = fakeSha("head-1");
    const repo = repoWith({ open: [{ number: 1, head, updatedAt: RECENT }], done: donePrs(1), contexts: new Map([[head, [checkRun(7), status("ci/legacy")]]]), reviews: new Map([[1, [review(9)]]]) });
    const { api, sent } = backstopApi(repo);

    const snapshot = await readBackstopSnapshot(api, REQUEST);

    expect(snapshot.open).toEqual([
      {
        number: 1,
        headRefOid: head,
        baseRefName: "main",
        updatedAt: RECENT,
        head: { oid: head, contexts: [expect.objectContaining({ kind: "check", databaseId: 7, conclusion: "SUCCESS" }), { kind: "status", context: "ci/legacy", state: "SUCCESS", createdAt: "2026-01-01T00:00:00Z" }] },
        reviews: [review(9)],
      },
    ]);
    expect(snapshot.done).toEqual([{ number: 1, merged: true, mergedBy: "octo", mergeCommit: fakeSha("merge-1"), closedAt: RECENT, updatedAt: RECENT }]);
    expect(snapshot.main).toEqual({ tip: fakeSha("tip"), commits: [{ oid: fakeSha("tip"), contexts: [] }] });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.variables).toMatchObject({ owner: "o", name: "r", branch: "refs/heads/main", since: REQUEST.since, withOpen: true, withDone: true, withHistory: true });
  });

  it("pages more than 50 open PRs to the end, re-reading no other range", async () => {
    const { api, sent } = backstopApi(repoWith({ open: openPrs(120) }));

    const snapshot = await readBackstopSnapshot(api, REQUEST);

    expect(snapshot.open.map((pr) => pr.number)).toEqual(range(120));
    expect(sent.map((query) => [query.variables.withOpen, query.variables.withDone, query.variables.withHistory])).toEqual([
      [true, true, true],
      [true, false, false],
      [true, false, false],
    ]);
  });

  it("pages more than 20 closed PRs, stopping once a page reaches past the cursor's overlap", async () => {
    const stale = donePrs(5, "2025-12-31T23:40:00Z").map((pr) => ({ ...pr, number: pr.number + 100 }));
    const { api, sent } = backstopApi(repoWith({ done: [...donePrs(45), ...stale, ...donePrs(30, "2025-12-01T00:00:00Z")] }));

    const snapshot = await readBackstopSnapshot(api, REQUEST);

    expect(snapshot.done.map((pr) => pr.number)).toEqual(range(45));
    expect(sent).toHaveLength(3);
  });

  it("keeps a closed PR inside the overlap behind the cursor", async () => {
    const { api } = backstopApi(repoWith({ done: donePrs(1, "2025-12-31T23:55:00Z") }));

    const snapshot = await readBackstopSnapshot(api, REQUEST);

    expect(snapshot.done).toHaveLength(1);
  });

  it("pages more than 50 main commits back to the cursor, excluding it", async () => {
    const commits = mainCommits(130);
    const { api, sent } = backstopApi(repoWith({ main: commits }));

    const snapshot = await readBackstopSnapshot(api, { ...REQUEST, mainCursor: commits[120]! });

    expect(snapshot.main.tip).toBe(commits[0]);
    expect(snapshot.main.commits.map((commit) => commit.oid)).toEqual(commits.slice(0, 120));
    expect(sent).toHaveLength(3);
  });

  it("re-reads more than 50 contexts for that one head or main commit", async () => {
    const head = fakeSha("head-1");
    const tip = fakeSha("tip");
    const many = range(130).map(checkRun);
    const { api, sent } = backstopApi(repoWith({ open: [{ number: 1, head, updatedAt: RECENT }], contexts: new Map([[head, many], [tip, many]]) }));

    const snapshot = await readBackstopSnapshot(api, REQUEST);

    expect(snapshot.open[0]!.head!.contexts.map((context) => context.kind === "check" && context.databaseId)).toEqual(range(130));
    expect(snapshot.main.commits[0]!.contexts).toHaveLength(130);
    expect(sent.filter((query) => query.variables.oid !== undefined).map((query) => [query.variables.oid, query.variables.after])).toEqual([
      [head, "50"],
      [tip, "50"],
    ]);
  });

  it("re-reads more than 20 reviews for that one PR, oldest first", async () => {
    const { api } = backstopApi(repoWith({ open: openPrs(1), reviews: new Map([[1, range(145).map(review)]]) }));

    const snapshot = await readBackstopSnapshot(api, REQUEST);

    expect(snapshot.open[0]!.reviews.map((entry) => entry.databaseId)).toEqual(range(145));
  });
});

describe("a backstop range past its cap", () => {
  it("reads exactly 1,000 main commits whole", async () => {
    const { api } = backstopApi(repoWith({ main: mainCommits(1000) }));

    await expect(readBackstopSnapshot(api, REQUEST)).resolves.toMatchObject({ main: { commits: expect.any(Array) } });
  });

  it("throws BackstopTruncated at 1,001 main commits rather than answer 1,000", async () => {
    const { api } = backstopApi(repoWith({ main: mainCommits(1001) }));

    const error = await rejectionOf(readBackstopSnapshot(api, REQUEST), BackstopTruncated);

    expect(error).toMatchObject({ range: "main", cap: BACKSTOP_CAPS.main });
    expect(error.message).toContain("do not decide from a partial range");
  });

  it("throws BackstopTruncated past 200 closed PRs since the cursor", async () => {
    const { api } = backstopApi(repoWith({ done: donePrs(201) }));

    await expect(rejectionOf(readBackstopSnapshot(api, REQUEST), BackstopTruncated)).resolves.toMatchObject({ range: "done" });
  });
});

describe("a backstop query GitHub answers with errors", () => {
  const partial = () => repoWith({ open: openPrs(1), errors: [{ message: "Something went wrong while executing your query" }] });

  it("fails the read through gh even when data came back beside the errors", async () => {
    const { api } = backstopApi(partial());

    await expect(readBackstopSnapshot(api, REQUEST)).rejects.toThrow(/backstop snapshot of o\/r unreadable: Something went wrong/);
  });

  it("fails the read through Octokit even when data came back beside the errors", async () => {
    const { api } = backstopOctokitApi(partial());

    await expect(readBackstopSnapshot(api, REQUEST)).rejects.toThrow(/Something went wrong while executing your query/);
  });
});

describe("a backstop snapshot through Octokit's fetch", () => {
  it("posts the snapshot query to graphql and answers its shapes", async () => {
    const { api, sent } = backstopOctokitApi(repoWith({ open: openPrs(2), done: donePrs(1) }));

    const snapshot = await readBackstopSnapshot(api, REQUEST);

    expect(snapshot.open.map((pr) => pr.number)).toEqual([1, 2]);
    expect(snapshot.done).toHaveLength(1);
    expect(sent).toHaveLength(1);
  });
});

describe("what a backstop snapshot costs", () => {
  it("computes 2 points for a full page set of every range", () => {
    const requests = snapshotRequests({ open: true, done: true, history: true });

    expect(requests).toBe(203);
    expect(graphqlPoints(requests)).toBe(2);
  });

  it("computes 1 point for a later page of one range, the minimum", () => {
    expect(graphqlPoints(snapshotRequests({ open: false, done: true, history: false }))).toBe(1);
  });

  it("surfaces the summed cost GitHub reported and the last query's remaining points", async () => {
    const { api } = backstopApi(repoWith({ open: openPrs(60) }));

    const snapshot = await readBackstopSnapshot(api, REQUEST);

    expect(snapshot.rateLimit).toEqual({ cost: 2, remaining: 4998, resetAt: "2026-01-01T01:00:00Z", queries: 2 });
  });
});
