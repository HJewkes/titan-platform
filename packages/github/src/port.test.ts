import { describe, expect, it } from "vitest";
import { fakeGitHub, fakeSha, successRun } from "./fake.js";
import { githubPort } from "./port.js";
import { GitHubInputError } from "./validate.js";

const REPO = "o/r";

function setup() {
  const fake = fakeGitHub();
  fake.refs.set("topic", fakeSha("topic"));
  return { fake, port: githubPort(fake.wire) };
}

describe("defaultBranch", () => {
  it("answers the repo's default branch, and validates the repo before any call", async () => {
    const fake = fakeGitHub({ base: "trunk" });
    const port = githubPort(fake.wire);

    expect(await port.defaultBranch(REPO)).toBe("trunk");
    await expect(port.defaultBranch("not a repo")).rejects.toBeInstanceOf(GitHubInputError);
  });
});

describe("deleteRef", () => {
  it("deletes a same-repo head once, then skips it as absent", async () => {
    const { fake, port } = setup();

    const first = await port.deleteRef(REPO, { branch: "topic", repo: REPO });
    const again = await port.deleteRef(REPO, { branch: "topic", repo: REPO });

    expect([first, again]).toEqual([{ done: true }, { done: false, skipped: "absent" }]);
    expect(fake.effects.deleteRef).toBe(1);
  });

  it("refuses the default branch", async () => {
    const { fake, port } = setup();

    expect(await port.deleteRef(REPO, { branch: "main", repo: REPO })).toEqual({ done: false, skipped: "default-branch" });
    expect(fake.refs.has("main")).toBe(true);
  });

  it.each([["alice/r"], [null]])("refuses a head that lives in repo %s", async (headRepo) => {
    const { fake, port } = setup();

    expect(await port.deleteRef(REPO, { branch: "topic", repo: headRepo })).toEqual({ done: false, skipped: "fork-head" });
    expect(fake.calls).toEqual([]);
  });

  it("validates the branch before any call", async () => {
    const { fake, port } = setup();

    await expect(port.deleteRef(REPO, { branch: "../main", repo: REPO })).rejects.toBeInstanceOf(GitHubInputError);
    expect(fake.calls).toEqual([]);
  });
});

describe("pushEmptyCommit", () => {
  it("pushes one commit with the head's tree onto the branch, and moves the branch's open PR to it", async () => {
    const { fake, port } = setup();
    const pr = fake.addPr({ headRef: "topic", headSha: fakeSha("topic") });

    const pushed = await port.pushEmptyCommit(REPO, "topic", fakeSha("topic"), "Start CI");

    expect(pushed).toMatchObject({ done: true });
    expect(fake.commits.get(pushed.sha)).toEqual({ sha: pushed.sha, parents: [fakeSha("topic")], tree: fakeSha(`tree:${fakeSha("topic")}`) });
    expect([fake.refs.get("topic"), fake.pr(pr.number).headSha, fake.effects.updateRef]).toEqual([pushed.sha, pushed.sha, 1]);
  });

  it("skips a branch that moved past the expected head, and pushes nothing", async () => {
    const { fake, port } = setup();

    expect(await port.pushEmptyCommit(REPO, "topic", fakeSha("older"), "Start CI")).toEqual({ sha: fakeSha("topic"), done: false, skipped: "head-moved" });
    expect(fake.calls).not.toContain("createCommit");
  });

  it("skips a branch that does not exist", async () => {
    const { port } = setup();

    expect(await port.pushEmptyCommit(REPO, "gone", fakeSha("topic"), "Start CI")).toEqual({ sha: "", done: false, skipped: "absent" });
  });
});

describe("listOpenPrs and jobLogTail", () => {
  it("lists only open PRs, filtered by head prefix", async () => {
    const { fake, port } = setup();
    fake.addPr({ headSha: fakeSha("a"), headRef: "shepherd/a" });
    fake.addPr({ headSha: fakeSha("b"), headRef: "other/b" });
    fake.addPr({ headSha: fakeSha("c"), headRef: "shepherd/c", state: "closed" });

    expect((await port.listOpenPrs(REPO, "shepherd/")).map((pr) => pr.headRef)).toEqual(["shepherd/a"]);
    expect(await port.listOpenPrs(REPO)).toHaveLength(2);
  });

  it("returns the last lines of a job log without a trailing blank", async () => {
    const { fake, port } = setup();
    fake.jobLogs.set(9, "one\r\ntwo\r\nthree\r\n");

    expect(await port.jobLogTail(REPO, 9, 2)).toBe("two\nthree");
    expect(await port.jobLogTail(REPO, 9, 10)).toBe("one\ntwo\nthree");
    await expect(port.jobLogTail(REPO, 9, 0)).rejects.toBeInstanceOf(GitHubInputError);
  });
});

describe("checkRuns", () => {
  it("returns every run on the sha, including a superseded one latestCheckRuns drops", async () => {
    const { fake, port } = setup();
    const sha = fakeSha("head");
    fake.setRuns(sha, [successRun("check", 1, "2026-01-01T00:00:00Z", "failure"), successRun("check", 2, "2026-01-02T00:00:00Z")]);

    expect((await port.checkRuns(REPO, sha)).map((run) => run.id)).toEqual([1, 2]);
    expect((await port.latestCheckRuns(REPO, sha)).map((run) => run.id)).toEqual([2]);
    await expect(port.checkRuns(REPO, "not-a-sha")).rejects.toBeInstanceOf(GitHubInputError);
  });
});
