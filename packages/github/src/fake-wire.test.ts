import { describe, expect, it } from "vitest";
import { FakeHttpError, fakeGitHub, fakeSha } from "./fake.js";
import { COMPARE_FILE_CAP } from "./port.js";
import { FORCE_PUSHES_CAP } from "./force-pushes.js";

const REPO = "octo/demo";

describe("fake wire handlers", () => {
  it("createRef refuses an existing branch and counts only the one that landed", async () => {
    const fake = fakeGitHub();

    await fake.wire.createRef(REPO, "topic", fakeSha("a"));
    await expect(fake.wire.createRef(REPO, "topic", fakeSha("b"))).rejects.toMatchObject({ status: 422 });

    expect(fake.effects.createRef).toBe(1);
    expect(fake.refs.get("topic")).toBe(fakeSha("a"));
    expect(fake.calls).toEqual(["createRef", "createRef"]);
  });

  it("deleteRef closes open PRs based on the branch and refuses a missing branch", async () => {
    const fake = fakeGitHub();
    fake.refs.set("stack", fakeSha("s"));
    fake.addPr({ baseRef: "stack" });
    fake.addPr({ baseRef: "main" });

    await fake.wire.deleteRef(REPO, "stack");

    expect(fake.pr(1).state).toBe("closed");
    expect(fake.pr(2).state).toBe("open");
    await expect(fake.wire.deleteRef(REPO, "stack")).rejects.toBeInstanceOf(FakeHttpError);
    expect(fake.effects.deleteRef).toBe(1);
  });

  it("getContent answers null for a missing file and the stored blob otherwise", async () => {
    const fake = fakeGitHub();
    fake.files.set("main:a.txt", { content: "hi", blobSha: "b1" });

    expect(await fake.wire.getContent(REPO, "a.txt", "main")).toEqual({ path: "a.txt", blobSha: "b1", content: "hi" });
    expect(await fake.wire.getContent(REPO, "b.txt", "main")).toBeNull();
  });

  it("getPr counts reads per PR and passes the count to onGetPr", async () => {
    const fake = fakeGitHub();
    const seen: number[] = [];
    fake.onGetPr = (_pr, count) => void seen.push(count);
    fake.addPr({});
    fake.addPr({});

    await fake.wire.getPr(REPO, 1);
    await fake.wire.getPr(REPO, 1);
    await fake.wire.getPr(REPO, 2);

    expect(seen).toEqual([1, 2, 1]);
    await expect(fake.wire.getPr(REPO, 9)).rejects.toMatchObject({ status: 404 });
  });

  it("getJobLog and getJobSteps answer 404 for an unknown job and copies for a known one", async () => {
    const fake = fakeGitHub();
    fake.jobLogs.set(7, "log text");
    fake.jobSteps.set(7, [{ name: "build", conclusion: "success" } as never]);

    expect(await fake.wire.getJobLog(REPO, 7)).toBe("log text");
    const steps = await fake.wire.getJobSteps(REPO, 7);
    expect(steps).toEqual(fake.jobSteps.get(7));
    expect(steps[0]).not.toBe(fake.jobSteps.get(7)![0]);
    await expect(fake.wire.getJobLog(REPO, 8)).rejects.toMatchObject({ status: 404 });
    await expect(fake.wire.getJobSteps(REPO, 8)).rejects.toMatchObject({ status: 404 });
  });

  it("rerunFailedJobs queues the run, and a fault either lands first or is thrown before", async () => {
    const fake = fakeGitHub();
    const lost = new Error("lost");
    const landed = new Error("landed");
    fake.rerunFaults = [{ error: lost }, { error: landed, lands: true }];

    await expect(fake.wire.rerunFailedJobs(REPO, 5)).rejects.toBe(lost);
    expect(fake.effects.rerunFailedJobs).toBe(0);
    await expect(fake.wire.rerunFailedJobs(REPO, 5)).rejects.toBe(landed);
    expect(fake.effects.rerunFailedJobs).toBe(1);
    expect(fake.runStatuses.get(5)).toBe("queued");
    await fake.wire.rerunFailedJobs(REPO, 6);
    expect(fake.effects.rerunFailedJobs).toBe(2);
  });

  it("createComment appends with the actor as author; a landing fault still stores it, a lost one does not", async () => {
    const fake = fakeGitHub();
    fake.createCommentFaults = [{ error: new Error("lost") }, { error: new Error("landed"), lands: true }];

    await expect(fake.wire.createComment(REPO, 3, "one")).rejects.toThrow("lost");
    expect(fake.comments.get(3)).toBeUndefined();
    await expect(fake.wire.createComment(REPO, 3, "two")).rejects.toThrow("landed");
    const { id } = await fake.wire.createComment(REPO, 3, "three");

    const listed = await fake.wire.listIssueComments(REPO, 3);
    expect(listed.map((comment) => comment.body)).toEqual(["two", "three"]);
    expect(listed.every((comment) => comment.author === "shepherd-bot")).toBe(true);
    expect(listed[1]!.id).toBe(id);
  });

  it("listPrFiles reports the stored count unless changedFiles overrides it", async () => {
    const fake = fakeGitHub();
    fake.prFiles.set(1, [{ path: "a.ts" } as never, { path: "b.ts" } as never]);
    fake.prFiles.set(2, [{ path: "c.ts" } as never]);
    fake.prChangedFiles.set(2, 40);

    expect((await fake.wire.listPrFiles(REPO, 1)).changedFiles).toBe(2);
    const second = await fake.wire.listPrFiles(REPO, 2);
    expect(second.changedFiles).toBe(40);
    expect(second.files).toHaveLength(1);
    expect(await fake.wire.listPrFiles(REPO, 3)).toEqual({ files: [], changedFiles: 0 });
  });

  it("listPrCommits defaults to the PR head", async () => {
    const fake = fakeGitHub();
    fake.addPr({ headSha: fakeSha("h") });

    expect(await fake.wire.listPrCommits(REPO, 1)).toEqual([fakeSha("h")]);
    fake.prCommits.set(1, ["x", "y"]);
    expect(await fake.wire.listPrCommits(REPO, 1)).toEqual(["x", "y"]);
  });

  it("listCommits keeps commits at or after since, newest first", async () => {
    const fake = fakeGitHub();
    fake.history.push(
      { sha: "old", message: "m0", committedAt: "2026-01-01T00:00:00Z" },
      { sha: "mid", message: "m1", committedAt: "2026-01-02T00:00:00Z" },
      { sha: "new", message: "m2", committedAt: "2026-01-03T00:00:00Z" },
    );

    expect(await fake.wire.listCommits(REPO, "2026-01-02T00:00:00Z")).toEqual([
      { sha: "new", message: "m2" },
      { sha: "mid", message: "m1" },
    ]);
  });

  it("compareFiles defaults to no change and flags truncation by file or commit count", async () => {
    const fake = fakeGitHub();
    fake.refs.set("a", fakeSha("a"));
    fake.compares.set("x...y", { mergeBaseSha: "mb", files: Array.from({ length: COMPARE_FILE_CAP }, (_, i) => `f${i}`) });
    fake.compares.set("p...q", { mergeBaseSha: "mb", files: ["f"], totalCommits: 100000 });
    fake.compares.set("r...s", { mergeBaseSha: "mb", files: ["f"] });

    expect(await fake.wire.compareFiles(REPO, "a", "z")).toEqual({ mergeBaseSha: fakeSha("a"), files: [], truncated: false });
    expect((await fake.wire.compareFiles(REPO, "x", "y")).truncated).toBe(true);
    expect((await fake.wire.compareFiles(REPO, "p", "q")).truncated).toBe(true);
    expect((await fake.wire.compareFiles(REPO, "r", "s")).truncated).toBe(false);
  });

  it("listForcePushes caps the page and says whether more remain", async () => {
    const fake = fakeGitHub();
    const push = (n: number) => ({ at: `t${n}` }) as never;
    fake.forcePushes.set(1, Array.from({ length: FORCE_PUSHES_CAP + 1 }, (_, i) => push(i)));
    fake.forcePushes.set(2, [push(0)]);

    const capped = await fake.wire.listForcePushes(REPO, 1);
    expect(capped.pushes).toHaveLength(FORCE_PUSHES_CAP);
    expect(capped.more).toBe(true);
    expect(await fake.wire.listForcePushes(REPO, 2)).toMatchObject({ more: false });
    expect(await fake.wire.listForcePushes(REPO, 3)).toEqual({ pushes: [], more: false });
  });

  it("listCheckRuns hides superseded attempts unless filter is all, and createCheckRun stamps the App id", async () => {
    const fake = fakeGitHub({ appId: 77 });
    const sha = fakeSha("c");
    await fake.wire.createCheckRun(REPO, { name: "n", headSha: sha, conclusion: "success" } as never);

    const runs = await fake.wire.listCheckRuns(REPO, sha, "all");
    expect(runs).toHaveLength(1);
    expect(runs[0]!.appId).toBe(77);
    expect(await fake.wire.listCheckRuns(REPO, sha, "latest")).toHaveLength(1);
  });
});
