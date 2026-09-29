import { describe, expect, it } from "vitest";
import { fakeGitHub, fakeSha } from "./fake.js";
import { githubPort } from "./port.js";
import { GitHubInputError } from "./validate.js";

const REPO = "o/r";

function setup() {
  const fake = fakeGitHub();
  fake.refs.set("topic", fakeSha("topic"));
  return { fake, port: githubPort(fake.wire) };
}

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
