import { describe, expect, it } from "vitest";
import { fetchRuns, parseArgs, summarize } from "./ci-timing.mjs";

const RELEASE_BRANCH = "release/main";
const BUDGET = { workflow: "ci.yml", releaseBranch: RELEASE_BRANCH, runs: { pull_request: 5, release_pr: 5, push: 0 } };

const listed = (databaseId, headBranch, seconds) => ({
  databaseId,
  headBranch,
  event: "pull_request",
  createdAt: `2026-01-05T10:00:0${databaseId}Z`,
  updatedAt: "2026-01-05T11:00:00Z",
  seconds,
});

const jobsFor = ({ seconds }) => [
  { name: "validate", conclusion: "success", startedAt: "2026-01-05T10:00:00Z", completedAt: new Date(Date.parse("2026-01-05T10:00:00Z") + seconds * 1000).toISOString(), steps: [] },
];

function fakeGh(runs) {
  const calls = [];
  const gh = (args) => {
    calls.push(args);
    if (args[1] === "view") return JSON.stringify({ jobs: jobsFor(runs.find((run) => String(run.databaseId) === args[2])) });
    const at = args.indexOf("--branch");
    const onBranch = at < 0 ? runs : runs.filter((run) => run.headBranch === args[at + 1]);
    return JSON.stringify(onBranch.map(({ seconds: _seconds, ...run }) => run));
  };
  return { gh, calls };
}

const fetched = (gh) => fetchRuns(gh, parseArgs(["--repo", "example/repo"], BUDGET));

describe("ci timing release PR sample", () => {
  const runs = [listed(1, "feat/a", 300), listed(2, RELEASE_BRANCH, 1600), listed(3, "feat/b", 500)];

  it("keeps a release PR run out of the pull request stats", () => {
    const rows = summarize(fetched(fakeGh(runs).gh));

    const job = (event) => rows.find((row) => row.event === event && row.kind === "job");
    expect(job("pull_request")).toMatchObject({ n: 2, max: 500 });
  });

  it("counts a release PR run under its own event", () => {
    const rows = summarize(fetched(fakeGh(runs).gh));

    expect(rows.find((row) => row.event === "release_pr" && row.kind === "job")).toMatchObject({ n: 1, max: 1600 });
  });

  it("lists the release sample as pull request runs on the release branch", () => {
    const { gh, calls } = fakeGh(runs);

    fetched(gh);

    const releaseList = calls.find((args) => args[1] === "list" && args.includes("--branch"));
    expect(releaseList).toEqual(expect.arrayContaining(["--event", "pull_request", "--branch", RELEASE_BRANCH]));
  });

  it("keeps release PR runs in the pull request sample when the budget names no release branch", () => {
    const { gh, calls } = fakeGh([...runs, { ...listed(4, undefined, 400) }]);
    const budget = { workflow: "ci.yml", runs: { pull_request: 5, push: 0 } };

    const rows = summarize(fetchRuns(gh, parseArgs(["--repo", "example/repo"], budget)));

    const listedEvents = calls.filter((args) => args[1] === "list").map((args) => args[args.indexOf("--event") + 1]);
    expect(listedEvents).toEqual(["pull_request", "push"]);
    expect(rows.find((row) => row.event === "pull_request" && row.kind === "job")).toMatchObject({ n: 4, max: 1600 });
  });
});
