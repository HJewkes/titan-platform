import fs from "node:fs";
import path from "node:path";
import { RECLAIM_GRACE_MS } from "@titan-design/worktree";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  commitIn,
  ctxFor,
  git,
  makeRepo,
  removeTempDirs,
  tempDir,
  updateRemoteMain,
  withRemote,
} from "./fixtures/git-repo.js";
import { createWorktreeStrategy, inspectForRelease, refusalOf, type Allocation } from "./index.js";

vi.setConfig({ testTimeout: 30_000 });
afterEach(() => {
  vi.unstubAllEnvs();
  removeTempDirs();
});

// The gh shims finish in milliseconds; the package's 3s default reads a loaded CI runner as no proof (TP-4367).
const worktreeStrategy = createWorktreeStrategy({ ghTimeoutMs: 120_000 });

describe("worktree release", () => {
  it("removes the worktree and branch when nothing would be lost", async () => {
    const repo = makeRepo();
    const ctx = ctxFor(repo);
    const alloc = await worktreeStrategy.allocate(ctx);

    expect(await worktreeStrategy.release(ctx, alloc)).toBe(true);
    expect(fs.existsSync(alloc.cwd)).toBe(false);
    expect(git(["branch", "--list", "agent-chat/alice"], repo)).toBe("");
  });

  it("refuses while the worktree has uncommitted work, and leaves it on disk", async () => {
    const repo = makeRepo();
    const ctx = ctxFor(repo);
    const alloc = await worktreeStrategy.allocate(ctx);
    fs.writeFileSync(path.join(alloc.cwd, "scratch.ts"), "half-finished\n");

    expect(await worktreeStrategy.release(ctx, alloc)).toBe(false);
    expect(fs.readFileSync(path.join(alloc.cwd, "scratch.ts"), "utf8")).toBe("half-finished\n");
  });

  it("refuses while commits exist nowhere but this branch", async () => {
    const repo = makeRepo();
    const ctx = ctxFor(repo);
    const alloc = await worktreeStrategy.allocate(ctx);
    commitIn(alloc.cwd, "feature.ts");

    expect(await worktreeStrategy.release(ctx, alloc)).toBe(false);
    expect(git(["branch", "--list", "agent-chat/alice"], repo)).toContain("agent-chat/alice");
  });

  it("releases once those commits are also on the remote", async () => {
    const repo = makeRepo();
    withRemote(repo);
    const ctx = ctxFor(repo);
    const alloc = await worktreeStrategy.allocate(ctx);
    commitIn(alloc.cwd, "feature.ts");
    git(["push", "origin", "agent-chat/alice"], alloc.cwd);

    expect(await worktreeStrategy.release(ctx, alloc)).toBe(true);
  });

  it("destroys unpushed work only when forced", async () => {
    const repo = makeRepo();
    const ctx = ctxFor(repo);
    const alloc = await worktreeStrategy.allocate(ctx);
    commitIn(alloc.cwd, "feature.ts");

    expect(await worktreeStrategy.release(ctx, alloc, { force: true })).toBe(true);
    expect(fs.existsSync(alloc.cwd)).toBe(false);
    expect(git(["branch", "--list", "agent-chat/alice"], repo)).toBe("");
  });

  it("holds a just-exited agent inside the grace window even when clean", async () => {
    const repo = makeRepo();
    const alloc = await worktreeStrategy.allocate(ctxFor(repo));

    const justExited = ctxFor(repo, { stoppedAt: Date.now() });
    expect(await worktreeStrategy.release(justExited, alloc)).toBe(false);
    expect(refusalOf(alloc)).toContain("reclaim grace window");
    expect(fs.existsSync(alloc.cwd)).toBe(true);

    const longExited = ctxFor(repo, { stoppedAt: Date.now() - RECLAIM_GRACE_MS - 1000 });
    expect(await worktreeStrategy.release(longExited, alloc)).toBe(true);
    expect(refusalOf(alloc)).toBeUndefined();
  });

  it("reports refusal rather than success for an allocation it does not recognise", async () => {
    const repo = makeRepo();
    const alien: Allocation = { cwd: repo };
    expect(await worktreeStrategy.release(ctxFor(repo), alien)).toBe(false);
  });
});

/**
 * CC-125. A squash or rebase merge leaves the agent's own commits off main, and GitHub deletes the
 * remote branch, so the commit count alone called landed work unmerged and retire refused.
 */
describe("worktree release after the work landed", () => {
  const squashMerge = (repo: string, branch: string): void => {
    git(["merge", "--squash", branch], repo);
    git(["commit", "-m", "squashed"], repo);
  };

  /** What a merge does on GitHub: main moves, and the merged branch is deleted. */
  const landOnRemote = (remote: string, repo: string): void => {
    updateRemoteMain(remote, repo);
    git(["branch", "-D", "agent-chat/alice"], remote);
    git(["fetch", "--prune", "origin"], repo);
  };

  it("releases a branch that was squash-merged and whose remote branch was deleted", async () => {
    const repo = makeRepo();
    const remote = withRemote(repo);
    const ctx = ctxFor(repo);
    const alloc = await worktreeStrategy.allocate(ctx);
    commitIn(alloc.cwd, "feature.ts");
    commitIn(alloc.cwd, "more.ts");
    git(["push", "origin", "agent-chat/alice"], alloc.cwd);
    squashMerge(repo, "agent-chat/alice");
    landOnRemote(remote, repo);

    expect(await worktreeStrategy.release(ctx, alloc)).toBe(true);
    expect(git(["branch", "--list", "agent-chat/alice"], repo)).toBe("");
  });

  it("releases a branch that was rebase-merged onto a base that had moved on", async () => {
    const repo = makeRepo();
    const ctx = ctxFor(repo);
    const alloc = await worktreeStrategy.allocate(ctx);
    commitIn(alloc.cwd, "feature.ts");
    commitIn(repo, "unrelated.ts");
    git(["cherry-pick", "main..agent-chat/alice"], repo);

    expect(await worktreeStrategy.release(ctx, alloc)).toBe(true);
  });

  it("refuses when only part of the branch landed, and names the missing landing", async () => {
    const repo = makeRepo();
    const ctx = ctxFor(repo);
    const alloc = await worktreeStrategy.allocate(ctx);
    const first = commitIn(alloc.cwd, "feature.ts");
    commitIn(alloc.cwd, "more.ts");
    commitIn(repo, "unrelated.ts");
    git(["cherry-pick", first], repo);

    expect(await worktreeStrategy.release(ctx, alloc)).toBe(false);
    expect(refusalOf(alloc)).toMatch(/work not landed on main/);
  });

  it("names the dirty worktree when that is what refuses", async () => {
    const repo = makeRepo();
    const ctx = ctxFor(repo);
    const alloc = await worktreeStrategy.allocate(ctx);
    fs.writeFileSync(path.join(alloc.cwd, "scratch.ts"), "half-finished\n");

    expect(await worktreeStrategy.release(ctx, alloc)).toBe(false);
    expect(refusalOf(alloc)).toBe("uncommitted changes in the worktree");
  });

  it("names the unpushed commit count when a never-merged branch refuses", async () => {
    const repo = makeRepo();
    const ctx = ctxFor(repo);
    const alloc = await worktreeStrategy.allocate(ctx);
    commitIn(alloc.cwd, "feature.ts");
    commitIn(alloc.cwd, "more.ts");

    expect(await worktreeStrategy.release(ctx, alloc)).toBe(false);
    expect(refusalOf(alloc)).toMatch(/^2 commit\(s\) not on [0-9a-f]{40}; work not landed on main/);
    expect(git(["branch", "--list", "agent-chat/alice"], repo)).toContain("agent-chat/alice");
  });

  it("still discards a dirty, never-merged branch when forced", async () => {
    const repo = makeRepo();
    const ctx = ctxFor(repo);
    const alloc = await worktreeStrategy.allocate(ctx);
    commitIn(alloc.cwd, "feature.ts");
    fs.writeFileSync(path.join(alloc.cwd, "scratch.ts"), "half-finished\n");

    expect(await worktreeStrategy.release(ctx, alloc, { force: true })).toBe(true);
    expect(git(["branch", "--list", "agent-chat/alice"], repo)).toBe("");
  });

  /** CC-792. Once main edits a file the branch touched, the file check refuses a squash-merged branch; gh's merged head is then the only proof it landed. */
  describe("when gh reports the PR", () => {
    /** A stand-in gh that prints `output` and exits with `code`. */
    const fakeGh = (output: string, code = 0): void => {
      const bin = tempDir("fake-gh-");
      fs.writeFileSync(path.join(bin, "out.json"), output);
      const script = `#!/bin/sh\ncat '${path.join(bin, "out.json")}'\nexit ${code}\n`;
      fs.writeFileSync(path.join(bin, "gh"), script, { mode: 0o755 });
      vi.stubEnv("PATH", `${bin}${path.delimiter}${process.env.PATH ?? ""}`);
    };

    /** Squash-merged, remote branch deleted, then main edits a file the branch touched. */
    const squashedThenEdited = async () => {
      const repo = makeRepo();
      const remote = withRemote(repo);
      const ctx = ctxFor(repo);
      const alloc = await worktreeStrategy.allocate(ctx);
      const first = commitIn(alloc.cwd, "feature.ts");
      const tip = commitIn(alloc.cwd, "more.ts");
      git(["push", "origin", "agent-chat/alice"], alloc.cwd);
      squashMerge(repo, "agent-chat/alice");
      fs.writeFileSync(path.join(repo, "feature.ts"), "later fix on main\n");
      git(["commit", "-am", "later fix"], repo);
      landOnRemote(remote, repo);
      return { repo, ctx, alloc, first, tip };
    };

    /** gh's view of the PR: `state`, the merged head, and the PR's commit oids. */
    const prJson = (state: string, headRefOid: string, commits: readonly string[] | string): string =>
      JSON.stringify({
        state,
        headRefOid,
        commits: typeof commits === "string" ? commits : commits.map((oid) => ({ oid })),
      });

    /** update-branch's merge commit, pushed to the PR head but never fetched locally. */
    const MOVED_HEAD = "f".repeat(40);

    it("releases a squash-merged branch when gh reports the PR merged at its exact tip", async () => {
      const { repo, ctx, alloc, first, tip } = await squashedThenEdited();
      fakeGh(prJson("MERGED", tip, [first, tip]));

      expect(await worktreeStrategy.release(ctx, alloc)).toBe(true);
      expect(git(["branch", "--list", "agent-chat/alice"], repo)).toBe("");
    });

    it("refuses when a local commit follows the head gh reports merged", async () => {
      const { repo, ctx, alloc, first, tip } = await squashedThenEdited();
      commitIn(alloc.cwd, "after.ts");
      fakeGh(prJson("MERGED", tip, [first, tip]));

      expect(await worktreeStrategy.release(ctx, alloc)).toBe(false);
      expect(refusalOf(alloc)).toMatch(/^3 commit\(s\) not on [0-9a-f]{40}; work not landed on main/);
      expect(git(["branch", "--list", "agent-chat/alice"], repo)).toContain("agent-chat/alice");
    });

    it("releases a squash-merged branch whose tip is in the PR after the head moved past it", async () => {
      const { repo, ctx, alloc, first, tip } = await squashedThenEdited();
      fakeGh(prJson("MERGED", MOVED_HEAD, [first, tip, MOVED_HEAD]));

      expect(await worktreeStrategy.release(ctx, alloc)).toBe(true);
      expect(git(["branch", "--list", "agent-chat/alice"], repo)).toBe("");
    });

    it("refuses when a local commit outside the PR follows a moved head", async () => {
      const { repo, ctx, alloc, first, tip } = await squashedThenEdited();
      commitIn(alloc.cwd, "after.ts");
      fakeGh(prJson("MERGED", MOVED_HEAD, [first, tip, MOVED_HEAD]));

      expect(await worktreeStrategy.release(ctx, alloc)).toBe(false);
      expect(refusalOf(alloc)).toMatch(/^3 commit\(s\) not on [0-9a-f]{40}; /);
      expect(refusalOf(alloc)).toMatch(/gh reports the PR as MERGED$/);
      expect(git(["branch", "--list", "agent-chat/alice"], repo)).toContain("agent-chat/alice");
    });

    it("refuses when gh reports a moved head with malformed commits", async () => {
      const { repo, ctx, alloc } = await squashedThenEdited();
      fakeGh(prJson("MERGED", MOVED_HEAD, "x"));

      expect(await worktreeStrategy.release(ctx, alloc)).toBe(false);
      expect(git(["branch", "--list", "agent-chat/alice"], repo)).toContain("agent-chat/alice");
    });

    it("refuses when gh fails", async () => {
      const { ctx, alloc } = await squashedThenEdited();
      fakeGh("", 1);

      expect(await worktreeStrategy.release(ctx, alloc)).toBe(false);
      expect(refusalOf(alloc)).toMatch(/work not landed on main/);
    });

    it("refuses when gh reports the PR still open at the same tip", async () => {
      const { ctx, alloc, first, tip } = await squashedThenEdited();
      fakeGh(prJson("OPEN", tip, [first, tip]));

      expect(await worktreeStrategy.release(ctx, alloc)).toBe(false);
      expect(refusalOf(alloc)).toMatch(/gh reports the PR as OPEN$/);
    });
  });
});

/**
 * TP-640 P8. Release once ran `git status --porcelain`, which hides ignored files, and read a failed
 * status as clean. It must fail closed: an ignored file, a status that cannot be read, an ignored
 * list that cannot be read, and a removal git refuses all leave the tree and its branch on disk.
 */
describe("worktree release fails closed", () => {
  const branch = "agent-chat/worker";
  const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

  /** Fails the one git call named in `fault`, and drops its own dir from PATH so `git` is the real one. */
  function writeFaultShim(bin: string, fault: string): void {
    const script = [
      "#!/bin/sh",
      `PATH=$(printf '%s' "$PATH" | tr ':' '\\n' | grep -vxF ${quote(bin)} | paste -sd: -)`,
      "export PATH",
      `fault=$(cat ${quote(fault)} 2>/dev/null)`,
      'if [ "$fault" = status ] && [ "$1" = status ]; then exit 1; fi',
      'if [ "$fault" = ignored ] && [ "$1" = ls-files ]; then exit 1; fi',
      'if [ "$fault" = remove ] && [ "$1" = worktree ] && [ "$2" = remove ]; then',
      '  printf "%s\\n" "synthetic removal refusal" >&2; exit 1',
      "fi",
      'exec git "$@"',
      "",
    ].join("\n");
    fs.writeFileSync(path.join(bin, "git"), script, { mode: 0o755 });
  }

  function fixture() {
    const repo = makeRepo();
    const root = tempDir("release-fail-closed-");
    const bin = path.join(root, "bin");
    const fault = path.join(root, "fault");
    fs.mkdirSync(bin);
    const base = git(["rev-parse", "HEAD"], repo);
    const tree = path.join(repo, ".worktrees", "worker");
    git(["worktree", "add", "-qb", branch, tree], repo);
    writeFaultShim(bin, fault);
    vi.stubEnv("PATH", bin + path.delimiter + (process.env.PATH ?? ""));
    const allocation: Allocation = { cwd: tree, ref: { branch, worktree: tree, gitRoot: repo, base } };
    return { repo, tree, base, fault, allocation };
  }

  type Fixture = ReturnType<typeof fixture>;

  const release = (f: Fixture) =>
    createWorktreeStrategy().release(
      { agentId: "synthetic-release", agentName: "worker", baseCwd: f.repo },
      f.allocation,
    );

  function expectKept(f: Fixture): void {
    expect(fs.existsSync(f.tree)).toBe(true);
    expect(git(["branch", "--list", branch], f.repo)).toContain(branch);
  }

  it("counts an ignored file that no build regenerates as dirty, and keeps it on release", async () => {
    const f = fixture();
    fs.appendFileSync(path.join(f.repo, ".git", "info", "exclude"), "\nlate-owned-note.txt\n");
    const note = path.join(f.tree, "late-owned-note.txt");
    fs.writeFileSync(note, "harmless owned note\n");
    expect(git(["status", "--porcelain", "-uall"], f.tree)).toBe("");

    const safety = await inspectForRelease(f.repo, f.tree, branch, f.base);
    const released = await release(f);

    expect(safety.dirty).toBe(true);
    expect(released).toBe(false);
    expect(refusalOf(f.allocation)).toContain("ignored files");
    expect(fs.readFileSync(note, "utf8")).toBe("harmless owned note\n");
    expectKept(f);
  });

  it.each([
    ["status-error", "status", "could not read git status"],
    ["ignored-error", "ignored", "could not list ignored files"],
  ])("refuses release when git status fails closed (%s)", async (_kind, fault, detail) => {
    const f = fixture();
    fs.writeFileSync(f.fault, fault);

    const safety = await inspectForRelease(f.repo, f.tree, branch, f.base);
    const released = await release(f);

    expect(safety.dirty).toBe(true);
    expect(released).toBe(false);
    expect(refusalOf(f.allocation)).toContain(detail);
    expectKept(f);
  });

  it("reports a refused removal of a clean tree as not released, and keeps the branch", async () => {
    const f = fixture();
    expect((await inspectForRelease(f.repo, f.tree, branch, f.base)).dirty).toBe(false);
    fs.writeFileSync(f.fault, "remove");

    const released = await release(f);

    expect(released).toBe(false);
    expect(refusalOf(f.allocation)).toContain("git would not remove");
    expectKept(f);
  });

  it("releases a clean tree when git answers every call", async () => {
    const f = fixture();

    expect(await release(f)).toBe(true);
    expect(fs.existsSync(f.tree)).toBe(false);
    expect(git(["branch", "--list", branch], f.repo)).toBe("");
  });

  it("releases a built tree whose only ignored files are tsbuildinfo", async () => {
    const f = fixture();
    fs.appendFileSync(path.join(f.repo, ".git", "info", "exclude"), "\n*.tsbuildinfo\n");
    fs.writeFileSync(path.join(f.tree, "tsconfig.tsbuildinfo"), "{}\n");
    fs.writeFileSync(path.join(f.tree, "tsconfig.test.tsbuildinfo"), "{}\n");

    const safety = await inspectForRelease(f.repo, f.tree, branch, f.base);
    const released = await release(f);

    expect(safety.dirty).toBe(false);
    expect(released).toBe(true);
    expect(fs.existsSync(f.tree)).toBe(false);
  });
});
