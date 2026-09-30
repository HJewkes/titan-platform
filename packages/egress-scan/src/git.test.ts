import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  commitsForRange,
  commitsForUpdate,
  MAX_PATCH_BYTES,
  parsePrePush,
  PatchTooLargeError,
  readCommit,
} from "./git.js";
import { scan } from "./scan.js";
import { makeTestRepo, plantedHomePath, tempDir, ZERO_SHA, type TestRepo } from "./test-repo.js";

const repos: TestRepo[] = [];

function newRepo(): TestRepo {
  const repo = makeTestRepo();
  repos.push(repo);
  return repo;
}

afterEach(() => {
  for (const repo of repos.splice(0)) fs.rmSync(repo.dir, { recursive: true, force: true });
});

function findings(repo: TestRepo, shas: readonly string[]): string[] {
  const result = scan(shas.map((sha) => readCommit(repo.dir, sha)));
  return result.findings.map((f) => `${f.location} ${f.rule}`);
}

describe("pre-push ranges", () => {
  it("scans only the commits between the remote sha and the local sha for an existing branch", () => {
    const repo = newRepo();
    const onRemote = repo.commit("already pushed");
    const first = repo.commit("first new");
    const second = repo.commit("second new");

    const commits = commitsForUpdate(repo.dir, "origin", { localSha: second, remoteSha: onRemote });

    expect(commits).toEqual([first, second]);
  });

  it("scans a new branch's commits that no ref of the remote already has", () => {
    const repo = newRepo();
    const shared = repo.commit("on origin");
    repo.git(["update-ref", "refs/remotes/origin/main", shared]);
    const first = repo.commit("branch one");
    const second = repo.commit("branch two");

    const commits = commitsForUpdate(repo.dir, "origin", { localSha: second, remoteSha: ZERO_SHA });

    expect(commits).toEqual([first, second]);
  });

  it("treats a remote sha missing locally as a new branch instead of failing", () => {
    const repo = newRepo();
    const only = repo.commit("local");

    const commits = commitsForUpdate(repo.dir, "origin", { localSha: only, remoteSha: "1".repeat(40) });

    expect(commits).toEqual([only]);
  });

  it("skips a ref deletion", () => {
    const repo = newRepo();
    const sha = repo.commit("anything");
    const [update] = parsePrePush(`(delete) ${ZERO_SHA} refs/heads/gone ${sha}\n`);

    expect(update && commitsForUpdate(repo.dir, "origin", update)).toEqual([]);
  });

  it("scans the head commit alone when the range base is all zeros", () => {
    const repo = newRepo();
    repo.commit("earlier");
    const head = repo.commit("head");

    expect(commitsForRange(repo.dir, ZERO_SHA, head)).toEqual([head]);
  });
});

describe("per-commit scanning", () => {
  it("fails a push whose leak is added in one commit and removed in the next", () => {
    const repo = newRepo();
    const base = repo.commit("base");
    repo.write("notes.md", `see ${plantedHomePath()}\n`);
    const leak = repo.commit("add notes");
    repo.write("notes.md", "see the docs\n");
    const head = repo.commit("scrub notes");

    const result = findings(repo, commitsForRange(repo.dir, base, head));

    expect(result).toEqual([`commit ${leak.slice(0, 7)} notes.md:1 home-path`]);
  });

  it("reports a line that only a merge commit adds", () => {
    const repo = newRepo();
    repo.write("f.txt", "one\n");
    repo.commit("base");
    repo.git(["checkout", "-q", "-b", "side"]);
    repo.write("side.txt", "side\n");
    repo.commit("side");
    repo.git(["checkout", "-q", "main"]);
    repo.git(["merge", "-q", "--no-commit", "side"]);
    repo.write("f.txt", `one\n${plantedHomePath()}\n`);
    const merge = repo.commit("merge side");

    expect(findings(repo, [merge])).toEqual([`commit ${merge.slice(0, 7)} f.txt:2 home-path`]);
  });

  it("reports a merge's line from a parent outside the scanned range, which a dense combined diff hides", () => {
    const repo = newRepo();
    repo.write("f.txt", ["1", "2", "3", "4", "5", "6", "7", "8", ""].join("\n"));
    repo.commit("base");
    repo.git(["checkout", "-q", "-b", "side"]);
    repo.write("f.txt", ["1", plantedHomePath(), "3", "4", "5", "6", "7", "8", ""].join("\n"));
    const side = repo.commit("side edits line 2");
    repo.git(["checkout", "-q", "main"]);
    repo.write("f.txt", ["1", "2", "3", "4", "5", "6", "seven", "8", ""].join("\n"));
    repo.commit("main edits line 7");
    repo.git(["merge", "-q", "--no-edit", "side"]);
    const merge = repo.git(["rev-parse", "HEAD"]).trim();

    const result = findings(repo, commitsForRange(repo.dir, side, merge));

    expect(result).toEqual([`commit ${merge.slice(0, 7)} f.txt:2 home-path`]);
  });
});

describe("option injection", () => {
  it("refuses a commit value that begins with a dash and writes no file", () => {
    const repo = newRepo();
    repo.commit("base");
    const outDir = tempDir("egress-out-");
    const target = path.join(outDir, "leaked-output");

    expect(() => readCommit(repo.dir, `--output=${target}`)).toThrow("commit is not a sha or ref name");
    expect(fs.existsSync(target)).toBe(false);
    fs.rmSync(outDir, { recursive: true, force: true });
  });

  it("refuses a remote name that begins with a dash", () => {
    const repo = newRepo();
    const sha = repo.commit("base");

    expect(() => commitsForUpdate(repo.dir, "--all", { localSha: sha, remoteSha: ZERO_SHA })).toThrow(
      "remote is not a remote name",
    );
  });
});

describe("the patch size limit", () => {
  /** The bytes git prints for the commit, measured apart from the scanner's own call. */
  function patchBytes(repo: TestRepo, sha: string): number {
    const args = ["show", "-c", "--text", "-U0", "--no-color", "--no-ext-diff", "--no-textconv", "--no-relative"];
    const prefixes = ["--src-prefix=a/", "--dst-prefix=b/", "--format=%B%x00", sha];
    return spawnSync("git", [...args, ...prefixes], { cwd: repo.dir }).stdout.length;
  }

  it("is 128 MiB", () => {
    expect(MAX_PATCH_BYTES).toBe(128 * 1024 * 1024);
  });

  it("reads a commit whose patch bytes equal the limit and refuses one byte less", () => {
    const repo = newRepo();
    repo.commit("base");
    repo.write("wide.md", "é".repeat(2000) + "\n");
    const sha = repo.commit("multibyte, so bytes and characters differ");
    const bytes = patchBytes(repo, sha);

    expect(readCommit(repo.dir, sha, bytes).files).toHaveLength(1);
    expect(() => readCommit(repo.dir, sha, bytes - 1)).toThrow(PatchTooLargeError);
  });

  it("names the short sha and the limit in MiB when the limit is a whole number of them", () => {
    expect(new PatchTooLargeError("abcdef0123456789", MAX_PATCH_BYTES).message).toBe(
      "commit abcdef0: patch text is over the scan limit of 128 MiB; refusing it",
    );
  });
});
