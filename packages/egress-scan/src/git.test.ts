import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  commitsForRange,
  commitsForUpdate,
  listRemoteTips,
  MAX_PATCH_BYTES,
  parsePrePush,
  PatchTooLargeError,
  readCommit,
} from "./git.js";
import { scan } from "./scan.js";
import { makeTestRepo, plantedHomePath, tempDir, ZERO_SHA, type TestRepo } from "./test-repo.js";

const repos: TestRepo[] = [];
const bares: string[] = [];

function newRepo(): TestRepo {
  const repo = makeTestRepo();
  repos.push(repo);
  return repo;
}

afterEach(() => {
  for (const repo of repos.splice(0)) fs.rmSync(repo.dir, { recursive: true, force: true });
  for (const dir of bares.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
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

  describe("a branch that merged main", () => {
    const flaggedFile = "notes.txt";
    const flaggedLine = `see ${plantedHomePath()}\n`;

    function setup() {
      const repo = newRepo();
      const bare = tempDir("egress-scan-remote-");
      bares.push(bare);
      spawnSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
      repo.git(["remote", "add", "origin", bare]);
      repo.commit("base");
      repo.git(["push", "-q", "origin", "main"]);
      repo.git(["checkout", "-q", "-b", "feature"]);
      const branchTip = repo.commit("branch work");
      repo.git(["push", "-q", "origin", "feature"]);
      repo.git(["checkout", "-q", "main"]);
      repo.write(flaggedFile, flaggedLine);
      const onMain = repo.commit("flagged but already on the remote");
      // Removed again, so the merge's own diff stays clean and only the earlier commit carries the flag.
      fs.rmSync(path.join(repo.dir, flaggedFile));
      repo.commit("remove it again");
      repo.git(["push", "-q", "origin", "main"]);
      repo.git(["checkout", "-q", "feature"]);
      return { repo, bare, branchTip, onMain };
    }

    it("skips a flagged commit that came in from a main the remote already has", () => {
      const { repo, bare, branchTip, onMain } = setup();
      repo.git(["merge", "-q", "--no-ff", "-m", "merge main", "main"]);
      const merge = repo.git(["rev-parse", "HEAD"]).trim();

      const commits = commitsForUpdate(repo.dir, "origin", { localSha: merge, remoteSha: branchTip }, { pushUrl: bare });

      expect(commits).toEqual([merge]);
      expect(commits).not.toContain(onMain);
      expect(findings(repo, commits)).toEqual([]);
    });

    it("still refuses a new flagged commit made on the branch itself", () => {
      const { repo, bare, branchTip } = setup();
      repo.git(["merge", "-q", "--no-ff", "-m", "merge main", "main"]);
      repo.write("fresh.txt", flaggedLine);
      const fresh = repo.commit("flagged on the branch");

      const commits = commitsForUpdate(repo.dir, "origin", { localSha: fresh, remoteSha: branchTip }, { pushUrl: bare });

      expect(commits).toContain(fresh);
      expect(findings(repo, commits).length).toBeGreaterThan(0);
    });

    it("excludes only what the named remote has", () => {
      const { repo, bare, branchTip, onMain } = setup();
      repo.git(["remote", "rename", "origin", "upstream"]);
      repo.git(["merge", "-q", "--no-ff", "-m", "merge main", "main"]);
      const merge = repo.git(["rev-parse", "HEAD"]).trim();

      const commits = commitsForUpdate(repo.dir, "upstream", { localSha: merge, remoteSha: branchTip }, { pushUrl: bare });

      expect(commits).toEqual([merge]);
      expect(commits).not.toContain(onMain);
    });

    function mergeUnpushedBranch() {
      const ctx = setup();
      const { repo } = ctx;
      repo.git(["checkout", "-q", "-b", "hidden", "main"]);
      repo.write("hidden.txt", flaggedLine);
      const hiddenTip = repo.commit("flagged and never pushed");
      repo.git(["checkout", "-q", "feature"]);
      repo.git(["merge", "-q", "--no-ff", "-m", "merge hidden", "hidden"]);
      const merge = repo.git(["rev-parse", "HEAD"]).trim();
      return { ...ctx, hiddenTip, merge };
    }

    it("does not trust a local tracking ref the remote never had", () => {
      const { repo, bare, branchTip, hiddenTip, merge } = mergeUnpushedBranch();
      repo.git(["update-ref", "refs/remotes/origin/fake", hiddenTip]);

      const commits = commitsForUpdate(repo.dir, "origin", { localSha: merge, remoteSha: branchTip }, { pushUrl: bare });

      expect(commits).toContain(hiddenTip);
      expect(findings(repo, commits).length).toBeGreaterThan(0);
    });

    it("does not trust a stale tracking ref whose branch the remote deleted", () => {
      const { repo, bare, branchTip, hiddenTip, merge } = mergeUnpushedBranch();
      repo.git(["push", "-q", "origin", "hidden:gone"]);
      repo.git(["fetch", "-q", "origin"]);
      spawnSync("git", ["-C", bare, "branch", "-q", "-D", "gone"]);

      const commits = commitsForUpdate(repo.dir, "origin", { localSha: merge, remoteSha: branchTip }, { pushUrl: bare });

      expect(commits).toContain(hiddenTip);
    });

    it("falls back to the full remote..local range when the remote cannot be listed", () => {
      const { repo, branchTip, onMain } = setup();
      repo.git(["merge", "-q", "--no-ff", "-m", "merge main", "main"]);
      const merge = repo.git(["rev-parse", "HEAD"]).trim();
      const gone = path.join(repo.dir, "no-such-remote");

      const commits = commitsForUpdate(repo.dir, "origin", { localSha: merge, remoteSha: branchTip }, { pushUrl: gone });

      expect(commits).toContain(onMain);
      expect(commits).toContain(merge);
    });

    function splitUrls(rewrite: "pushurl" | "insteadOf") {
      const ctx = mergeUnpushedBranch();
      const { repo, bare } = ctx;
      const priv = tempDir("egress-scan-private-");
      bares.push(priv);
      spawnSync("git", ["clone", "-q", "--bare", repo.dir, priv]);
      repo.git(["remote", "set-url", "origin", priv]);
      if (rewrite === "pushurl") repo.git(["remote", "set-url", "--push", "origin", bare]);
      else repo.git(["config", `url.${bare}.pushInsteadOf`, priv]);
      return ctx;
    }

    it.each(["pushurl", "insteadOf"] as const)("lists the push url, not the fetch url (%s)", (rewrite) => {
      const { repo, bare, branchTip, hiddenTip, merge } = splitUrls(rewrite);

      const commits = commitsForUpdate(repo.dir, "origin", { localSha: merge, remoteSha: branchTip }, { pushUrl: bare });

      expect(commits).toContain(hiddenTip);
      expect(findings(repo, commits).length).toBeGreaterThan(0);
    });

    it("falls back to the full range when git passes no push url", () => {
      const { repo, branchTip, onMain } = setup();
      repo.git(["merge", "-q", "--no-ff", "-m", "merge main", "main"]);
      const merge = repo.git(["rev-parse", "HEAD"]).trim();

      const commits = commitsForUpdate(repo.dir, "origin", { localSha: merge, remoteSha: branchTip });

      expect(commits).toContain(onMain);
    });

    it("falls back to the full range when listing the remote outlasts the timeout", () => {
      const { repo, branchTip, onMain } = setup();
      repo.git(["merge", "-q", "--no-ff", "-m", "merge main", "main"]);
      const merge = repo.git(["rev-parse", "HEAD"]).trim();
      const hang = path.join(tempDir("egress-scan-hang-"), "ssh");
      bares.push(path.dirname(hang));
      fs.writeFileSync(hang, "#!/bin/sh\nexec sleep 3 >/dev/null 2>&1\n", { mode: 0o755 });

      const started = Date.now();
      const commits = commitsForUpdate(
        repo.dir,
        "origin",
        { localSha: merge, remoteSha: branchTip },
        { pushUrl: "ssh://host/repo", timeoutMs: 300, env: { ...process.env, GIT_SSH_COMMAND: hang } },
      );

      expect(Date.now() - started).toBeLessThan(2500);
      expect(commits).toContain(onMain);
    });

    it("throws instead of passing when rev-list fails", () => {
      const { repo, bare, branchTip } = setup();

      expect(() => commitsForUpdate(repo.dir, "origin", { localSha: "2".repeat(40), remoteSha: branchTip }, { pushUrl: bare })).toThrow(
        /rev-list failed/,
      );
    });
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

describe("a merge commit against parents the remote already has", () => {
  const flaggedLine = `see ${plantedHomePath()}\n`;

  /** main holds a flagged commit the remote has; feature (also on the remote) is about to merge it for real. */
  function setup() {
    const repo = newRepo();
    const bare = tempDir("egress-scan-remote-");
    bares.push(bare);
    spawnSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
    repo.git(["remote", "add", "origin", bare]);
    repo.write("base.txt", "base\n");
    repo.commit("base");
    repo.git(["push", "-q", "origin", "main"]);
    repo.git(["checkout", "-q", "-b", "feature"]);
    repo.write("feature.txt", "feature\n");
    const branchTip = repo.commit("branch work");
    repo.git(["push", "-q", "origin", "feature"]);
    repo.git(["checkout", "-q", "main"]);
    repo.write("landed.md", flaggedLine);
    repo.commit("flagged but already on the remote");
    repo.git(["push", "-q", "origin", "main"]);
    repo.git(["checkout", "-q", "feature"]);
    return { repo, bare, branchTip };
  }

  function pushFindings(repo: TestRepo, bare: string, branchTip: string): string[] {
    const localSha = repo.git(["rev-parse", "HEAD"]).trim();
    const update = { localSha, remoteSha: branchTip };
    const commits = commitsForUpdate(repo.dir, "origin", update, { pushUrl: bare });
    const tips = listRemoteTips(repo.dir, { pushUrl: bare });
    const result = scan(commits.map((sha) => readCommit(repo.dir, sha, undefined, tips, new Set(commits))));
    return result.findings.map((f) => `${f.location} ${f.rule}`);
  }

  it("passes a non-fast-forward merge of a main whose flagged commit is already on the remote", () => {
    const { repo, bare, branchTip } = setup();
    repo.git(["merge", "-q", "--no-ff", "-m", "merge main", "main"]);

    expect(pushFindings(repo, bare, branchTip)).toEqual([]);
  });

  it("refuses a flagged line the merge resolution itself adds", () => {
    const { repo, bare, branchTip } = setup();
    repo.git(["merge", "-q", "--no-commit", "--no-ff", "main"]);
    repo.write("resolved.txt", flaggedLine);
    const merge = repo.commit("merge main");

    expect(pushFindings(repo, bare, branchTip)).toEqual([`commit ${merge.slice(0, 7)} resolved.txt:1 home-path`]);
  });

  it("refuses a flagged line a merge resolution adds to a file with a NUL byte", () => {
    const { repo, bare, branchTip } = setup();
    repo.git(["merge", "-q", "--no-commit", "--no-ff", "main"]);
    repo.write("blob.bin", `a\0\n${plantedHomePath()}\n`);
    const merge = repo.commit("merge main");

    expect(pushFindings(repo, bare, branchTip)).toEqual([`commit ${merge.slice(0, 7)} blob.bin:2 home-path`]);
  });

  it("refuses a new flagged commit on the branch made before the merge", () => {
    const { repo, bare, branchTip } = setup();
    repo.write("fresh.txt", flaggedLine);
    const fresh = repo.commit("new flagged work");
    repo.git(["merge", "-q", "--no-ff", "-m", "merge main", "main"]);

    expect(pushFindings(repo, bare, branchTip)).toEqual([`commit ${fresh.slice(0, 7)} fresh.txt:1 home-path`]);
  });

  it("refuses a parent that only a local tracking ref holds, when fetch and push URLs name different repositories", () => {
    const repo = newRepo();
    const privateBare = tempDir("egress-scan-private-");
    const publicBare = tempDir("egress-scan-public-");
    bares.push(privateBare, publicBare);
    for (const bare of [privateBare, publicBare]) spawnSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
    repo.git(["remote", "add", "origin", privateBare]);
    repo.write("base.txt", "base\n");
    const base = repo.commit("base");
    repo.git(["push", "-q", publicBare, "main"]);
    repo.write("landed.md", flaggedLine);
    repo.commit("flagged, only on the private remote");
    repo.git(["push", "-q", "origin", "main"]);
    repo.git(["checkout", "-q", "-b", "fresh", base]);
    repo.write("fresh.txt", "fresh\n");
    repo.commit("branch work");
    repo.git(["merge", "-q", "--no-ff", "-m", "merge main", "origin/main"]);
    const merge = repo.git(["rev-parse", "HEAD"]).trim();

    const commits = commitsForUpdate(repo.dir, "origin", { localSha: merge, remoteSha: ZERO_SHA }, { pushUrl: publicBare });
    const tips = listRemoteTips(repo.dir, { pushUrl: publicBare });
    const result = scan(commits.map((sha) => readCommit(repo.dir, sha, undefined, tips, new Set(commits))));

    expect(result.findings.map((f) => `${f.location} ${f.rule}`)).toEqual([`commit ${merge.slice(0, 7)} landed.md:1 home-path`]);
  });

  it("refuses the landed text when the push URL cannot be listed", () => {
    const { repo, branchTip } = setup();
    repo.git(["merge", "-q", "--no-ff", "-m", "merge main", "main"]);
    const merge = repo.git(["rev-parse", "HEAD"]).trim();
    const gone = path.join(tempDir("egress-scan-gone-"), "missing.git");
    bares.push(path.dirname(gone));

    const tips = listRemoteTips(repo.dir, { pushUrl: gone });
    const result = scan([readCommit(repo.dir, merge, undefined, tips)]);

    expect(tips).toBeUndefined();
    expect(branchTip).not.toBe(merge);
    expect(result.findings.map((f) => `${f.location} ${f.rule}`)).toEqual([`commit ${merge.slice(0, 7)} landed.md:1 home-path`]);
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
    const args = ["show", "--diff-merges=separate", "--format=", "--text", "-U0", "--no-color", "--no-ext-diff"];
    const prefixes = ["--no-textconv", "--no-relative", "--src-prefix=a/", "--dst-prefix=b/", sha];
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

  it("fails naming git show when the commit does not exist", () => {
    const repo = newRepo();
    repo.commit("base");

    expect(() => readCommit(repo.dir, "deadbeef")).toThrow("git show failed");
  });

  it("names the short sha and the limit in MiB when the limit is a whole number of them", () => {
    expect(new PatchTooLargeError("abcdef0123456789", MAX_PATCH_BYTES).message).toBe(
      "commit abcdef0: patch text is over the scan limit of 128 MiB; refusing it",
    );
  });
});
