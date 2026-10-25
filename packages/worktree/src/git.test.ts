import { describe, expect, it } from "vitest";
import { findGitRoot, gitChildEnv, observedPresence, type GitRunner } from "./git.js";

/** A git that answers from a table, so a worktree layout is a fixture not a setup script. */
const fakeGit =
  (answers: Record<string, string | null>): GitRunner =>
  async (args) =>
    answers[args.join(" ")] ?? null;

const BRANCH = "rev-parse --abbrev-ref HEAD";
const TOPLEVEL = "rev-parse --show-toplevel";
const COMMON = "rev-parse --path-format=absolute --git-common-dir";
const GITDIR = "rev-parse --path-format=absolute --git-dir";

describe("observedPresence", () => {
  it("reads branch and checkout in a main working tree", async () => {
    const git = fakeGit({
      [BRANCH]: "feat/presence",
      [TOPLEVEL]: "/repo",
      [COMMON]: "/repo/.git",
      [GITDIR]: "/repo/.git",
    });

    expect(await observedPresence("/repo", git)).toEqual({
      gitBranch: "feat/presence",
      worktreePath: "/repo",
      repoPath: "/repo",
      isLinkedWorktree: false,
    });
  });

  it("marks a linked worktree, where the common dir and the git dir disagree", async () => {
    const git = fakeGit({
      [BRANCH]: "agent-chat/scout",
      [TOPLEVEL]: "/repo/.worktrees/scout",
      [COMMON]: "/repo/.git",
      [GITDIR]: "/repo/.git/worktrees/scout",
    });

    const observed = await observedPresence("/repo/.worktrees/scout", git);

    expect(observed).toMatchObject({ worktreePath: "/repo/.worktrees/scout", isLinkedWorktree: true });
    expect(observed?.repoPath).toBe("/repo");
    expect(observed?.repoPath).not.toBe(observed?.worktreePath);
  });

  it('omits the branch on a detached HEAD rather than reporting the string "HEAD"', async () => {
    const git = fakeGit({ [BRANCH]: "HEAD", [TOPLEVEL]: "/repo", [COMMON]: "/repo/.git", [GITDIR]: "/repo/.git" });

    const observed = await observedPresence("/repo", git);

    expect(observed?.gitBranch).toBeUndefined();
    expect(observed?.worktreePath).toBe("/repo");
  });

  it("reports nothing at all outside a repository", async () => {
    expect(await observedPresence("/tmp", fakeGit({}))).toBeUndefined();
  });
});

describe("findGitRoot", () => {
  it("resolves a linked worktree to the repository behind it, not the worktree", async () => {
    expect(await findGitRoot("/repo/.worktrees/scout", fakeGit({ [COMMON]: "/repo/.git" }))).toBe("/repo");
  });

  it("answers null outside a repository", async () => {
    expect(await findGitRoot("/tmp", fakeGit({}))).toBeNull();
  });
});

const EXT_NEVER = { GIT_CONFIG_KEY_0: "protocol.ext.allow", GIT_CONFIG_VALUE_0: "never", GIT_CONFIG_COUNT: "1" };

describe("gitChildEnv", () => {
  it("drops the dispatcher identity variables and disables credential prompts", () => {
    const env = gitChildEnv({ PATH: "/usr/bin", AGENT_CHAT_NAME: "scout", AGENT_CHAT_ID: "a1" });

    expect(env).toEqual({ PATH: "/usr/bin", GIT_TERMINAL_PROMPT: "0", ...EXT_NEVER });
  });

  it("drops the prefixes a caller names instead of the defaults", () => {
    const env = gitChildEnv({ OTHER_TOKEN: "x", AGENT_CHAT_NAME: "scout" }, ["OTHER_"]);

    expect(env).toEqual({ AGENT_CHAT_NAME: "scout", GIT_TERMINAL_PROMPT: "0", ...EXT_NEVER });
  });

  it("leaves the protocol list unset when the caller exported only the legacy full list", () => {
    const env = gitChildEnv({ PATH: "/usr/bin", GIT_ALLOW_PROTOCOL: "file:git:http:https:ssh" });

    expect(env).toEqual({ PATH: "/usr/bin", GIT_TERMINAL_PROMPT: "0", ...EXT_NEVER });
  });

  it("keeps the caller's config pairs and appends the ext pair last", () => {
    const env = gitChildEnv({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "user.name", GIT_CONFIG_VALUE_0: "fixture" });

    expect(env).toEqual({
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_KEY_0: "user.name",
      GIT_CONFIG_VALUE_0: "fixture",
      GIT_CONFIG_KEY_1: "protocol.ext.allow",
      GIT_CONFIG_VALUE_1: "never",
      GIT_CONFIG_COUNT: "2",
    });
  });
});
