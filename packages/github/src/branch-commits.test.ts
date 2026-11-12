import { describe, expect, it } from "vitest";
import type { GhExec, GhResult } from "./exec.js";
import { fakeGitHub, fakeSha } from "./fake.js";
import { ghCliWire } from "./gh-cli.js";
import { COMPARE_COMMIT_CAP, githubPort } from "./port.js";
import { rateBudget } from "./budget.js";

const REPO = "octo/demo";

function included(headers: Record<string, string>, body: unknown): GhResult {
  const head = ["HTTP/2.0 200 OK", ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`)].join("\r\n");
  return { code: 0, stdout: `${head}\r\n\r\n${JSON.stringify(body)}`, stderr: "" };
}

function byFragment(answers: Record<string, GhResult>): { exec: GhExec; lines: string[] } {
  const lines: string[] = [];
  const exec: GhExec = async (args) => {
    const line = args.join(" ");
    lines.push(line);
    const key = Object.keys(answers).find((fragment) => line.includes(fragment));
    if (key === undefined) throw new Error(`unscripted gh call: ${line}`);
    return answers[key]!;
  };
  return { exec, lines };
}

const wireOver = (exec: GhExec) => githubPort(ghCliWire(exec, { budget: rateBudget() }));
const nextLink = (path: string) => ({ link: `<https://api.github.com/${path}>; rel="next"` });

const ghCommit = (tag: string, author: string | null, committer: string | null, message: string) => ({
  sha: fakeSha(tag),
  author: author === null ? null : { login: author },
  committer: committer === null ? null : { login: committer },
  commit: { message, author: { name: "Someone", email: "someone@example.test" } },
});

describe("listBranchCommits", () => {
  it("adapter maps the compare response to commits with logins and the branch's changed files", async () => {
    const first = { merge_base_commit: { sha: fakeSha("base") }, total_commits: 2, commits: [ghCommit("c1", "sweep-bot[bot]", "sweep-bot[bot]", "bump: package.json")], files: [{ filename: "package.json" }] };
    const second = { merge_base_commit: { sha: fakeSha("base") }, total_commits: 2, commits: [ghCommit("c2", null, "web-flow", "edit")], files: [] };
    const gh = byFragment({ "page=2": included({}, second), "compare/main...feature": included(nextLink("repositories/1/compare/main...feature?per_page=100&page=2"), first) });

    const read = await wireOver(gh.exec).listBranchCommits(REPO, "main", "feature");

    expect(read).toEqual({
      mergeBaseSha: fakeSha("base"),
      commits: [
        { sha: fakeSha("c1"), authorLogin: "sweep-bot[bot]", committerLogin: "sweep-bot[bot]", message: "bump: package.json" },
        { sha: fakeSha("c2"), authorLogin: null, committerLogin: "web-flow", message: "edit" },
      ],
      files: ["package.json"],
      truncated: false,
    });
    expect(gh.lines[0]).toContain("repos/octo/demo/compare/main...feature");
  });

  it("flags a compare whose total runs past the commits GitHub listed as truncated", async () => {
    const page = { merge_base_commit: { sha: fakeSha("base") }, total_commits: 300, commits: [ghCommit("c1", "a", "a", "m")], files: [] };
    const gh = byFragment({ compare: included({}, page) });

    expect((await wireOver(gh.exec).listBranchCommits(REPO, "main", "feature")).truncated).toBe(true);
  });

  it("refuses a head ref that could escape the compare path before any call", async () => {
    const gh = byFragment({});

    await expect(wireOver(gh.exec).listBranchCommits(REPO, "main", "../x")).rejects.toThrow();
    expect(gh.lines).toEqual([]);
  });

  it("fake answers the seeded commits, capped at 250 like GitHub, and an unseeded pair as none", async () => {
    const fake = fakeGitHub();
    const commits = Array.from({ length: COMPARE_COMMIT_CAP + 1 }, (_, i) => ({ sha: fakeSha(`c${i}`), authorLogin: "a", committerLogin: "a", message: `m${i}` }));
    fake.compares.set("main...feature", { mergeBaseSha: fakeSha("base"), files: ["package.json"], commits });
    const port = githubPort(fake.wire);

    const read = await port.listBranchCommits("o/r", "main", "feature");

    expect(read.commits).toHaveLength(COMPARE_COMMIT_CAP);
    expect(read.truncated).toBe(true);
    expect(await port.listBranchCommits("o/r", "main", "other")).toMatchObject({ commits: [], files: [], truncated: false });
  });
});

describe("actorLogin", () => {
  it("answers the configured login without a read, else the authenticated user", async () => {
    const fake = fakeGitHub();
    fake.actor = "someone";

    expect(await githubPort(fake.wire, { login: "sweep-bot[bot]" }).actorLogin()).toBe("sweep-bot[bot]");
    expect(fake.calls).not.toContain("getAuthenticatedLogin");
    expect(await githubPort(fake.wire).actorLogin()).toBe("someone");
  });
});
