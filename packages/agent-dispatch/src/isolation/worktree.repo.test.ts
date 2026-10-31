import fs from "node:fs";
import path from "node:path";
import { findGitRoot, SETUP_FILE, WorktreeInUseError, type SetupRunner } from "@titan-design/worktree";
import { afterEach, describe, expect, it, vi } from "vitest";
import { commitIn, ctxFor, git, makeRepo, removeTempDirs, tempDir } from "./fixtures/git-repo.js";
import {
  createIsolationRegistry,
  createWorktreeStrategy,
  reattachWorktree,
  recreateWorktree,
  refusalsIn,
  type IsolationContext,
} from "./index.js";

vi.setConfig({ testTimeout: 30_000 });
afterEach(() => {
  vi.unstubAllEnvs();
  removeTempDirs();
});

const worktreeStrategy = createWorktreeStrategy();

describe("worktree allocate", () => {
  it("puts the agent on its own branch in its own directory", async () => {
    const repo = makeRepo();
    const alloc = await worktreeStrategy.allocate(ctxFor(repo));

    expect(alloc.cwd).toBe(path.join(repo, ".worktrees", "alice"));
    expect(fs.existsSync(alloc.cwd)).toBe(true);
    expect(alloc.ref?.branch).toBe("agent-chat/alice");
    expect(git(["rev-parse", "--abbrev-ref", "HEAD"], alloc.cwd)).toBe("agent-chat/alice");
    expect(alloc.note).toContain("agent-chat/alice");
  });

  it("copies .claude/ in so hooks still fire inside the worktree", async () => {
    const repo = makeRepo();
    fs.mkdirSync(path.join(repo, ".claude"));
    fs.writeFileSync(path.join(repo, ".claude", "settings.json"), "{}");

    const alloc = await worktreeStrategy.allocate(ctxFor(repo));
    expect(fs.existsSync(path.join(alloc.cwd, ".claude", "settings.json"))).toBe(true);
  });

  describe("a branch that commits .claude as a symlink (CC-459)", () => {
    /** The branch is committed first so adoption checks it out with the link in place. */
    function repoWithBranchSymlink(linkTarget: string): string {
      const repo = makeRepo();
      git(["checkout", "-b", "agent-chat/alice"], repo);
      fs.symlinkSync(linkTarget, path.join(repo, ".claude"));
      git(["add", ".claude"], repo);
      git(["commit", "-m", "commit .claude as a symlink"], repo);
      git(["checkout", "main"], repo);
      fs.mkdirSync(path.join(repo, ".claude"));
      fs.writeFileSync(path.join(repo, ".claude", "settings.json"), "{}");
      return repo;
    }

    it("survives a dangling symlink and writes nothing through it", async () => {
      const outside = path.join(tempDir("iso-outside-"), "dangling");
      const repo = repoWithBranchSymlink(outside);

      const alloc = await worktreeStrategy.allocate(ctxFor(repo));

      expect(fs.lstatSync(path.join(alloc.cwd, ".claude")).isSymbolicLink()).toBe(true);
      expect(fs.existsSync(outside)).toBe(false);
    });

    it("does not copy settings into a real directory outside the tree", async () => {
      const outside = tempDir("iso-outside-");
      const repo = repoWithBranchSymlink(outside);

      await worktreeStrategy.allocate(ctxFor(repo));

      expect(fs.readdirSync(outside)).toEqual([]);
    });
  });

  it("allocates against the main repo when called from inside a worktree", async () => {
    const repo = makeRepo();
    const first = await worktreeStrategy.allocate(ctxFor(repo));

    const nested = await worktreeStrategy.allocate(ctxFor(first.cwd, { agentName: "bob", agentId: "ag-2" }));
    expect(await findGitRoot(first.cwd)).toBe(repo);
    expect(nested.cwd).toBe(path.join(repo, ".worktrees", "bob"));
  });

  it("cannot be escaped by a hostile agent name", async () => {
    const repo = makeRepo();
    const alloc = await worktreeStrategy.allocate(ctxFor(repo, { agentName: "../../etc/pwned" }));
    expect(alloc.cwd.startsWith(path.join(repo, ".worktrees"))).toBe(true);
  });

  it("refuses outside a git repository", async () => {
    const dir = tempDir("iso-bare-");
    const reasons = await worktreeStrategy.check(ctxFor(dir));
    expect(refusalsIn(reasons)[0]).toContain("not a git repository");
    await expect(worktreeStrategy.allocate(ctxFor(dir))).rejects.toThrow("not a git repository");
  });

  it("warns from check when the agent's branch already exists, without refusing", async () => {
    const repo = makeRepo();
    git(["branch", "agent-chat/alice"], repo);

    const reasons = await worktreeStrategy.check(ctxFor(repo));

    expect(reasons).toEqual([expect.stringContaining("branch agent-chat/alice already exists")]);
    expect(refusalsIn(reasons)).toEqual([]);
  });

  it("keeps a repo that does not ignore its tree directory clean, with one exclude line (CC-916)", async () => {
    const repo = makeRepo();

    await worktreeStrategy.allocate(ctxFor(repo));
    await worktreeStrategy.allocate(ctxFor(repo, { agentName: "bob", agentId: "ag-2" }));

    const exclude = fs.readFileSync(path.join(repo, ".git", "info", "exclude"), "utf8");
    expect(git(["status", "--porcelain"], repo)).toBe("");
    expect(exclude.split("\n").filter((line) => line === "/.worktrees/")).toHaveLength(1);
  });
});

describe("worktree re-allocation after a crash", () => {
  /** The crash path: work committed, the process died, release was never called. */
  const crashLeavingCommit = async (ctx: IsolationContext): Promise<string> => {
    const alloc = await worktreeStrategy.allocate(ctx);
    const sha = commitIn(alloc.cwd, "work.ts");
    fs.rmSync(alloc.cwd, { recursive: true, force: true });
    return sha;
  };

  it("adopts the branch a crashed agent left behind rather than deleting its commits", async () => {
    const repo = makeRepo();
    const ctx = ctxFor(repo, { agentName: "scout" });
    const sha = await crashLeavingCommit(ctx);

    const second = await worktreeStrategy.allocate(ctx);
    expect(git(["rev-parse", "agent-chat/scout"], repo)).toBe(sha);
    expect(git(["rev-parse", "HEAD"], second.cwd)).toBe(sha);
    expect(second.ref?.reused).toBe("true");
  });

  it("discards that branch only when the caller asks for it", async () => {
    const repo = makeRepo();
    const ctx = ctxFor(repo, { agentName: "scout" });
    const sha = await crashLeavingCommit(ctx);

    const second = await worktreeStrategy.allocate({ ...ctx, forceReset: true });
    expect(git(["rev-parse", "HEAD"], second.cwd)).toBe(git(["rev-parse", "main"], repo));
    expect(git(["rev-parse", "HEAD"], second.cwd)).not.toBe(sha);
  });

  it("resets a leftover branch that holds nothing, so the agent starts from current HEAD", async () => {
    const repo = makeRepo();
    git(["branch", "agent-chat/alice"], repo);
    const moved = commitIn(repo, "later.ts");

    const alloc = await worktreeStrategy.allocate(ctxFor(repo));
    expect(git(["rev-parse", "HEAD"], alloc.cwd)).toBe(moved);
    expect(alloc.ref?.reused).toBeUndefined();
  });

  it("refuses rather than clobbering a worktree that is still on disk", async () => {
    const repo = makeRepo();
    const ctx = ctxFor(repo, { agentName: "scout" });
    const first = await worktreeStrategy.allocate(ctx);
    fs.writeFileSync(path.join(first.cwd, "scratch.ts"), "half-finished\n");

    await expect(worktreeStrategy.allocate(ctx)).rejects.toBeInstanceOf(WorktreeInUseError);
    expect(fs.readFileSync(path.join(first.cwd, "scratch.ts"), "utf8")).toBe("half-finished\n");
  });

  it("clobbers that worktree when forced, like release does", async () => {
    const repo = makeRepo();
    const ctx = ctxFor(repo, { agentName: "scout" });
    const first = await worktreeStrategy.allocate(ctx);
    fs.writeFileSync(path.join(first.cwd, "scratch.ts"), "half-finished\n");

    const second = await worktreeStrategy.allocate({ ...ctx, forceReset: true });
    expect(second.cwd).toBe(first.cwd);
    expect(fs.existsSync(path.join(second.cwd, "scratch.ts"))).toBe(false);
  });
});

describe("a sibling tree whose branch extends the name (CC-1082)", () => {
  /** Leaves `impl` parked with one commit and `impl-review` live beside it. */
  const parkBesideLiveReviewer = async (repo: string) => {
    const impl = await worktreeStrategy.allocate(ctxFor(repo, { agentName: "impl" }));
    const sha = commitIn(impl.cwd, "work.ts");
    git(["worktree", "remove", "--force", impl.cwd], repo);
    const review = await worktreeStrategy.allocate(ctxFor(repo, { agentName: "impl-review" }));
    return { implPath: impl.cwd, reviewPath: review.cwd, sha };
  };

  it("resumes the agent while its reviewer holds the -review branch", async () => {
    const repo = makeRepo();
    const { implPath, reviewPath, sha } = await parkBesideLiveReviewer(repo);

    const again = await reattachWorktree({ gitRoot: repo, worktree: implPath, branch: "agent-chat/impl" });

    expect(again.cwd).toBe(implPath);
    expect(again.ref?.reattached).toBe("local");
    expect(git(["branch", "--show-current"], implPath)).toBe("agent-chat/impl");
    expect(git(["rev-parse", "HEAD"], implPath)).toBe(sha);
    expect(git(["branch", "--show-current"], reviewPath)).toBe("agent-chat/impl-review");
  });

  it("allocates the agent onto its kept branch while its reviewer is live", async () => {
    const repo = makeRepo();
    const { sha } = await parkBesideLiveReviewer(repo);

    const again = await worktreeStrategy.allocate(ctxFor(repo, { agentName: "impl" }));

    expect(again.ref?.reused).toBe("true");
    expect(git(["rev-parse", "HEAD"], again.cwd)).toBe(sha);
  });

  it("still refuses when another tree really holds the branch", async () => {
    const repo = makeRepo();
    const { implPath } = await parkBesideLiveReviewer(repo);
    const other = path.join(repo, ".worktrees", "other");
    git(["worktree", "add", other, "agent-chat/impl"], repo);

    const resumed = reattachWorktree({ gitRoot: repo, worktree: implPath, branch: "agent-chat/impl" });

    await expect(resumed).rejects.toBeInstanceOf(WorktreeInUseError);
    await expect(resumed).rejects.toMatchObject({ worktreePath: other });
  });
});

/** `origin` with a pushed `agent-chat/p`, cloned into the checkout under test. */
function stackedClone(setupDeclaration?: string): string {
  const seed = makeRepo();
  if (setupDeclaration !== undefined) {
    fs.mkdirSync(path.dirname(path.join(seed, SETUP_FILE)), { recursive: true });
    fs.writeFileSync(path.join(seed, SETUP_FILE), setupDeclaration);
    git(["add", "."], seed);
    git(["commit", "-m", "declare setup"], seed);
  }
  const origin = path.join(tempDir("iso-origin-"), "origin.git");
  git(["clone", "--quiet", "--bare", seed, origin], seed);
  git(["remote", "add", "origin", origin], seed);
  git(["checkout", "--quiet", "-b", "agent-chat/p"], seed);
  commitIn(seed, "parent.ts");
  git(["push", "--quiet", "origin", "agent-chat/p"], seed);
  const local = path.join(tempDir("iso-clone-"), "repo");
  git(["clone", "--quiet", origin, local], seed);
  git(["config", "user.email", "test@example.com"], local);
  git(["config", "user.name", "Test"], local);
  git(["config", "commit.gpgsign", "false"], local);
  return local;
}

describe("stack base record (CC-1281)", () => {
  const KEY = "branch.agent-chat/alice.agent-chat-base";
  const recorded = (repo: string): string | null => {
    try {
      return git(["config", "--get", KEY], repo);
    } catch {
      return null;
    }
  };

  it("records the parent's branch name, without origin/, for a stacked spawn", async () => {
    const local = stackedClone();

    const alloc = await worktreeStrategy.allocate(ctxFor(local, { baseRef: "origin/agent-chat/p" }));

    expect(recorded(local)).toBe("agent-chat/p");
    expect(alloc.warnings).toBeUndefined();
  });

  it("leaves no record for a default-base spawn, clearing one a reused branch name inherited", async () => {
    const local = stackedClone();
    git(["config", KEY, "agent-chat/stale"], local);

    await worktreeStrategy.allocate(ctxFor(local));

    expect(recorded(local)).toBeNull();
  });

  it("still spawns, with a warning, when the record cannot be written", async () => {
    const local = stackedClone();
    git(["config", "--add", KEY, "x"], local);
    git(["config", "--add", KEY, "y"], local);

    const alloc = await worktreeStrategy.allocate(ctxFor(local, { baseRef: "origin/agent-chat/p" }));

    expect(fs.existsSync(path.join(alloc.cwd, "parent.ts"))).toBe(true);
    expect(alloc.warnings).toEqual([expect.stringContaining(`could not record ${KEY}=agent-chat/p`)]);
  });

  it("records the stack base before the setup step runs", async () => {
    const local = stackedClone(JSON.stringify({ setup: { command: ["default-command"] } }));
    const observed: (string | null)[] = [];
    const runSetup = vi.fn<SetupRunner>(async () => {
      observed.push(recorded(local));
      return { exitCode: 0, timedOut: false, output: "" };
    });

    const alloc = await createWorktreeStrategy({ runSetup }).allocate(
      ctxFor(local, { baseRef: "origin/agent-chat/p" }),
    );

    expect(observed).toEqual(["agent-chat/p"]);
    expect(Object.hasOwn(alloc, "setupTarget")).toBe(false);
  });
});

describe("re-creating a removed tree", () => {
  const removedTree = async (declaration?: string) => {
    const local = stackedClone(declaration);
    const runSetup = vi.fn<SetupRunner>(async () => ({ exitCode: 0, timedOut: false, output: "" }));
    const first = await createWorktreeStrategy({ runSetup }).allocate(ctxFor(local));
    git(["worktree", "remove", "--force", first.cwd], local);
    runSetup.mockClear();
    return { record: { gitRoot: local, worktree: first.cwd, branch: "agent-chat/alice" }, runSetup };
  };

  it("says the setup step reinstalled dependencies when one ran", async () => {
    const { record, runSetup } = await removedTree(JSON.stringify({ setup: { command: ["npm", "ci"] } }));

    const again = await reattachWorktree(record, { runSetup });

    expect(runSetup).toHaveBeenCalledOnce();
    expect(again.ref?.setup).toBe("ran");
    expect(again.note).toMatch(/reinstalled its dependencies/);
    expect(again.note).toContain("Commit your work there");
  });

  it("says to install and build when no step is declared", async () => {
    const { record, runSetup } = await removedTree();

    const again = await recreateWorktree(record, { runSetup });

    expect(runSetup).not.toHaveBeenCalled();
    expect(again.ref?.setup).toBe("none");
    expect(again.note).toMatch(/install dependencies and build/);
  });

  it("still says to install when the step fails", async () => {
    const { record } = await removedTree(JSON.stringify({ setup: { command: ["npm", "ci"] } }));
    const runSetup = vi.fn<SetupRunner>(async () => ({ exitCode: 1, timedOut: false, output: "failed\n" }));

    const again = await reattachWorktree(record, { runSetup });

    expect(again.ref?.setup).toBe("failed");
    expect(again.note).toMatch(/install dependencies and build/);
    expect(again.warnings).toEqual([expect.stringContaining("exited with code 1")]);
  });
});

/**
 * CC-72: a worktree the task system assigned is adopted, not allocated. Allocating takes a budget
 * slot and releasing removes the tree, which is destructive for one sibling agents may be using.
 */
describe("an assigned worktree", () => {
  const assignedIn = (repo: string): string => {
    const at = path.join(repo, "assigned-wt");
    git(["worktree", "add", "-b", "assigned-branch", at], repo);
    return at;
  };

  it("is used as-is, without creating a branch or taking a budget slot", async () => {
    const repo = makeRepo();
    const at = assignedIn(repo);
    const before = git(["branch", "--list"], repo);

    const strategy = createWorktreeStrategy({ budget: () => 1 });
    const alloc = await strategy.allocate(ctxFor(repo, { assignedWorktree: at }));

    expect(alloc.cwd).toBe(at);
    expect(alloc.ref?.assigned).toBe("true");
    expect(alloc.ref?.branch).toBe("assigned-branch");
    expect(git(["branch", "--list"], repo)).toBe(before);
  });

  it("warns the agent it may be sharing the tree, rather than claiming it owns it", async () => {
    const repo = makeRepo();
    const alloc = await worktreeStrategy.allocate(ctxFor(repo, { assignedWorktree: assignedIn(repo) }));
    expect(alloc.note).toMatch(/sharing it with other agents/);
  });

  it("refuses a path that does not exist, in the dispatch wording, rather than inventing one", async () => {
    const repo = makeRepo();
    const missing = path.join(repo, "nope");

    await expect(worktreeStrategy.allocate(ctxFor(repo, { assignedWorktree: missing }))).rejects.toThrow(
      `assigned worktree ${missing} does not exist, and agent-chat has no record of allocating it`,
    );
  });

  it("survives release, even forced: the task system owns it, not this agent", async () => {
    const repo = makeRepo();
    const at = assignedIn(repo);
    const ctx = ctxFor(repo, { assignedWorktree: at });
    const alloc = await worktreeStrategy.allocate(ctx);

    expect(await worktreeStrategy.release(ctx, alloc, { force: true })).toBe(true);
    expect(fs.existsSync(at)).toBe(true);
    expect(git(["branch", "--list", "assigned-branch"], repo)).toContain("assigned-branch");
  });
});

describe("registry and composition", () => {
  const registry = createIsolationRegistry({ worktree: worktreeStrategy });

  it("layers a toolset over a worktree: narrowed tools, worktree cwd", async () => {
    const repo = makeRepo();
    const ctx = ctxFor(repo, { toolset: { allowedTools: ["Read", "Edit"] } });
    const composed = registry.resolve(["toolset-limited", "worktree"]);

    const alloc = await composed.allocate(ctx);
    expect(alloc.cwd).toBe(path.join(repo, ".worktrees", "alice"));
    expect(alloc.allowedTools).toEqual(["Read", "Edit"]);
    expect(alloc.note).toContain("Read, Edit");
    expect(alloc.note).toContain("agent-chat/alice");

    expect(await composed.release(ctx, alloc)).toBe(true);
    expect(fs.existsSync(alloc.cwd)).toBe(false);
  });

  it("propagates the worktree refusing to release", async () => {
    const repo = makeRepo();
    const ctx = ctxFor(repo);
    const composed = registry.resolve(["toolset-limited", "worktree"]);
    const alloc = await composed.allocate(ctx);
    fs.writeFileSync(path.join(alloc.cwd, "scratch.ts"), "half-finished\n");

    expect(await composed.release(ctx, alloc)).toBe(false);
    expect(fs.existsSync(alloc.cwd)).toBe(true);
  });
});
