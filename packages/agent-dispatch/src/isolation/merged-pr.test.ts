import { afterEach, describe, expect, it } from "vitest";
import { makeRepo, removeTempDirs, withRemote } from "./fixtures/git-repo.js";
import { mergedPrReader, parseMergedPrs, type MergedPrGh } from "./merged-pr.js";

afterEach(removeTempDirs);

describe("reading gh's merged PRs for a head branch (CC-1064)", () => {
  it("takes each PR's head commit from headRefOid", () => {
    const stdout = JSON.stringify([
      { number: 929, headRefOid: "a".repeat(40), mergedAt: "2026-10-14T10:28:36Z" },
    ]);

    expect(parseMergedPrs(stdout)).toEqual([{ number: 929, headSha: "a".repeat(40) }]);
  });

  it("reads an empty list as no merged PR", () => {
    expect(parseMergedPrs("[]")).toEqual([]);
  });

  it("throws on an answer that is not a JSON array", () => {
    expect(() => parseMergedPrs('{"number":1}')).toThrow(/JSON array/);
  });

  it("throws on a PR without a head commit rather than trusting it", () => {
    expect(() => parseMergedPrs('[{"number":1}]')).toThrow(/headRefOid/);
  });
});

describe("asking gh for the merged PRs on a branch", () => {
  const answering = (exitCode: number, stdout = "[]") => {
    const calls: { args: readonly string[]; cwd: string }[] = [];
    const gh: MergedPrGh = async (args, cwd) => {
      calls.push({ args, cwd });
      return { exitCode, stdout };
    };
    return { gh, calls };
  };

  it("asks nothing of a repo with no origin, which has nowhere to hold a PR", async () => {
    const { gh, calls } = answering(0);

    expect(await mergedPrReader(gh)(makeRepo(), "agent-chat/worker")).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("reads the merged PRs headed by the branch, from inside the repo", async () => {
    const repo = makeRepo();
    withRemote(repo);
    const stdout = JSON.stringify([{ number: 7, headRefOid: "b".repeat(40) }]);
    const { gh, calls } = answering(0, stdout);

    const prs = await mergedPrReader(gh)(repo, "agent-chat/worker");

    expect(prs).toEqual([{ number: 7, headSha: "b".repeat(40) }]);
    expect(calls[0]?.cwd).toBe(repo);
    expect(calls[0]?.args.slice(0, 6)).toEqual([
      "pr",
      "list",
      "--head",
      "agent-chat/worker",
      "--state",
      "merged",
    ]);
  });

  it("rejects when gh exits non-zero, so park refuses rather than reading no PRs", async () => {
    const repo = makeRepo();
    withRemote(repo);

    await expect(mergedPrReader(answering(1).gh)(repo, "agent-chat/worker")).rejects.toThrow(/exited 1/);
  });
});
