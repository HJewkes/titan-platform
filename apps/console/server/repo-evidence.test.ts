import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeGitHub, githubPort } from "@titan-design/github";
import { gitEvidenceReader } from "./repo-evidence.js";

let dir: string;
let clone: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "console-evidence-"));
  clone = path.join(dir, "orbit");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Commits carry fixed dates, so which ref predates which merge does not depend on how fast the test runs. */
function git(args: string[], cwd: string, at = 1_000): string {
  const date = `@${at} +0000`;
  const env = { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
  return execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/**
 * origin/main holds a merged `XY-1:` commit at t=2000. `origin/pc-xy-1-old` was pushed before it, `origin/pc-xy-2-live`
 * after it, and `pc-xy-3-new` is a fresh worktree on main. Remote refs are written directly, so nothing is pushed.
 */
function seedRepository(): void {
  git(["init", "-b", "main", clone], dir);
  git(["commit", "--allow-empty", "-m", "Start"], clone, 1_000);
  git(["switch", "-c", "pc-xy-1-old"], clone);
  git(["commit", "--allow-empty", "-m", "Part one"], clone, 1_500);
  git(["switch", "main"], clone);
  git(["commit", "--allow-empty", "-m", "XY-1: Land part one (#1)"], clone, 2_000);
  git(["switch", "-c", "pc-xy-2-live"], clone);
  git(["commit", "--allow-empty", "-m", "Part two"], clone, 3_000);
  git(["switch", "main"], clone);
  for (const branch of ["main", "pc-xy-1-old", "pc-xy-2-live"]) git(["update-ref", `refs/remotes/origin/${branch}`, branch], clone);
  git(["branch", "-D", "pc-xy-1-old", "pc-xy-2-live"], clone);
  git(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"], clone);
  git(["remote", "add", "origin", "https://github.com/example/orbit.git"], clone);
  git(["worktree", "add", "-q", "-b", "pc-xy-3-new", path.join(dir, "tree")], clone);
}

describe("repository evidence", () => {
  it("reads worktrees, unmerged branches, merged ids and open pull requests once per repository", async () => {
    seedRepository();
    const fake = fakeGitHub({ repo: "example/orbit" });
    fake.addPr({ headSha: "a".repeat(40), headRef: "pc-xy-2-live" });

    const read = gitEvidenceReader({ github: githubPort(fake.wire, { login: "t" }) });
    const [evidence, ...rest] = await read([clone, path.join(dir, "tree"), clone]);

    expect(rest).toEqual([]);
    expect(evidence).toMatchObject({ repo: "example/orbit", openPrs: [{ repo: "example/orbit", number: 1, headRef: "pc-xy-2-live" }] });
    expect(evidence!.refs.map(({ name, kind, tipAt }) => [name, kind, tipAt]).sort()).toEqual([
      ["origin/pc-xy-1-old", "branch", 1_500],
      ["origin/pc-xy-2-live", "branch", 3_000],
      ["pc-xy-3-new", "worktree", 2_000],
    ]);
    expect([...evidence!.mergedAt]).toEqual([["XY-1", 2_000]]);
  });

  it("reuses a read within the cache window", async () => {
    seedRepository();
    const fake = fakeGitHub({ repo: "example/orbit" });
    const read = gitEvidenceReader({ github: githubPort(fake.wire, { login: "t" }), now: () => 0 });

    await read([clone]);
    await read([clone]);

    expect(fake.calls.filter((call) => call === "listOpenPrs")).toHaveLength(1);
  });

  it("marks pull requests unread when GitHub fails, and keeps the git evidence", async () => {
    seedRepository();
    const github = { listOpenPrs: async () => Promise.reject(new Error("offline")) };

    const [evidence] = await gitEvidenceReader({ github })([clone]);

    expect(evidence).toMatchObject({ openPrs: null, degraded: "Open pull requests in example/orbit unread: offline" });
    expect(evidence!.refs.length).toBeGreaterThan(0);
  });

  it("skips a path that is not a repository", async () => {
    expect(await gitEvidenceReader({ github: { listOpenPrs: async () => [] } })([path.join(dir, "absent")])).toEqual([]);
  });
});
