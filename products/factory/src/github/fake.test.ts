import { describe, expect, it } from "vitest";
import { fakeGitHub } from "./fake.js";
import { GitHubConflictError, githubPort } from "./port.js";

const REPO = "octo/demo";

describe("check-then-act port over the fake", () => {
  it("ensureBranch on an existing branch is a no-op that keeps the branch's sha", async () => {
    const fake = fakeGitHub();
    const port = githubPort(fake.wire);

    const first = await port.ensureBranch(REPO, "factory/doc-1", "base0000");
    fake.refs.set("factory/doc-1", "advanced1");
    const again = await port.ensureBranch(REPO, "factory/doc-1", "base0000");

    expect(first).toEqual({ sha: "base0000", done: true });
    expect(again).toEqual({ sha: "advanced1", done: false, skipped: "exists" });
    expect(fake.effects.createRef).toBe(1);
  });

  it("putFile with identical content is a no-op; a changed blob underneath is a conflict", async () => {
    const fake = fakeGitHub();
    const port = githubPort(fake.wire);
    const request = { path: "docs/a.md", branch: "main", content: "new", message: "Edit", expectedBlobSha: null };

    const first = await port.putFile(REPO, request);
    const again = await port.putFile(REPO, request);
    const stale = port.putFile(REPO, { ...request, content: "newer" });

    expect(first.done).toBe(true);
    expect(again).toEqual({ blobSha: first.blobSha, done: false, skipped: "unchanged" });
    await expect(stale).rejects.toBeInstanceOf(GitHubConflictError);
    expect(fake.effects.putContent).toBe(1);
  });

  it("openPr finds the PR a crashed attempt already opened, even after it merged", async () => {
    const fake = fakeGitHub();
    const port = githubPort(fake.wire);
    fake.refs.set("topic", "head1");
    const request = { head: "topic", base: "main", title: "T", body: "B" };

    const opened = await port.openPr(REPO, request);
    await port.merge(REPO, opened.pr.number, "head1", "squash");
    const again = await port.openPr(REPO, request);

    expect(again).toMatchObject({ done: false, skipped: "exists", pr: { number: opened.pr.number, merged: true } });
    expect(fake.effects.createPr).toBe(1);
  });

  it("merge is a no-op on a merged PR and returns the stored merge sha", async () => {
    const fake = fakeGitHub();
    const port = githubPort(fake.wire);
    const pr = fake.addPr({ headSha: "head1" });

    const first = await port.merge(REPO, pr.number, "head1", "squash");
    const again = await port.merge(REPO, pr.number, "head1", "squash");

    expect(again).toEqual({ mergeSha: first.mergeSha, done: false, skipped: "merged" });
    expect(fake.effects.merge).toBe(1);
  });

  it("merge refuses a head other than the one named, without calling GitHub's merge", async () => {
    const fake = fakeGitHub();
    const pr = fake.addPr({ headSha: "head1" });
    fake.pushHead(pr.number, "foreign1");

    const result = await githubPort(fake.wire).merge(REPO, pr.number, "head1", "squash");

    expect(result).toMatchObject({ done: false, skipped: "head-moved" });
    expect(fake.calls).not.toContain("merge");
  });

  it("updateBranch skips a head that moved, a branch that is current, and a merged PR", async () => {
    const fake = fakeGitHub();
    const port = githubPort(fake.wire);
    const behind = fake.addPr({ headSha: "head1", behind: true });
    const current = fake.addPr({ headSha: "head2" });

    const done = await port.updateBranch(REPO, behind.number, "head1");
    const moved = await port.updateBranch(REPO, behind.number, "head1");
    const upToDate = await port.updateBranch(REPO, current.number, "head2");

    expect([done, moved, upToDate]).toEqual([{ done: true }, { done: false, skipped: "head-moved" }, { done: false, skipped: "up-to-date" }]);
    expect(fake.effects.updateBranch).toBe(1);
  });

  it("rerunFailed does nothing while the run is already re-running", async () => {
    const fake = fakeGitHub();
    const port = githubPort(fake.wire);

    const first = await port.rerunFailed(REPO, 55);
    const again = await port.rerunFailed(REPO, 55);

    expect([first, again]).toEqual([{ done: true }, { done: false, skipped: "in-progress" }]);
    expect(fake.effects.rerunFailedJobs).toBe(1);
  });
});
