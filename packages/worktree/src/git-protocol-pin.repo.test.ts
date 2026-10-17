import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitChildEnv, pinGitProtocols, runGit, withPinnedGitProtocols } from "./git.js";
import { setupEnv } from "./setup.js";

// Relevant engine cases lifted from the dispatcher's CC-1095 git-protocol-pin suite.
const SAFE = "file:git:http:https:ssh";
const dirs: string[] = [];
function extRemoteRepo(): { repo: string; marker: string } {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "git-pin-")));
  dirs.push(dir);
  const repo = path.join(dir, "r"), marker = path.join(dir, "marker");
  const git = (...args: string[]): void => {
    execFileSync("git", args, { cwd: dir, env: { ...process.env, GIT_ALLOW_PROTOCOL: SAFE }, stdio: "ignore" });
  };
  git("init", "--quiet", repo);
  git("-C", repo, "config", "protocol.ext.allow", "always");
  git("-C", repo, "remote", "add", "x", `ext::sh -c touch% ${marker}`);
  return { repo, marker };
}
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe("pinGitProtocols", () => {
  it.each([
    [undefined, SAFE], ["ext", ""], ["https:ext:ssh", "https:ssh"], ["EXT:https", "https"],
    ["next:https", "https"], ["HTTPS:sshx", ""], ["", ""], ["https", "https"],
  ])("narrows %j to %j", (value, pinned) => {
    expect(pinGitProtocols(value)).toBe(pinned);
  });
  it("pins a subprocess environment without otherwise rewriting it", () => {
    expect(withPinnedGitProtocols({ PATH: "/bin", GIT_ALLOW_PROTOCOL: "ext:ssh" }))
      .toEqual({ PATH: "/bin", GIT_ALLOW_PROTOCOL: "ssh" });
  });
  it("preserves identity stripping while narrowing both default and custom git environments", () => {
    expect(gitChildEnv({ AGENT_CHAT_NAME: "fixture", GIT_ALLOW_PROTOCOL: "ext:https" }))
      .toEqual({ GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: "https" });
    expect(gitChildEnv({ PRIVATE_ID: "fixture", GIT_ALLOW_PROTOCOL: "" }, ["PRIVATE_"]))
      .toEqual({ GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: "" });
  });
});

describe("git the allocator runs itself", () => {
  let saved: string | undefined;
  beforeEach(() => { saved = process.env.GIT_ALLOW_PROTOCOL; });
  afterEach(() => {
    if (saved === undefined) delete process.env.GIT_ALLOW_PROTOCOL;
    else process.env.GIT_ALLOW_PROTOCOL = saved;
  });
  it.each([["ext"], [undefined]])("never runs a scratch ext remote when the host has GIT_ALLOW_PROTOCOL=%j", async value => {
    if (value === undefined) delete process.env.GIT_ALLOW_PROTOCOL;
    else process.env.GIT_ALLOW_PROTOCOL = value;
    const { repo, marker } = extRemoteRepo();
    const out = await runGit(["fetch", "x"], repo);
    expect(out).toBeNull();
    expect(fs.existsSync(marker)).toBe(false);
  });
});

describe("worktree setup environment", () => {
  it("pins the install environment using the same existing policy", () => {
    expect(setupEnv({ GIT_ALLOW_PROTOCOL: "ext" }).GIT_ALLOW_PROTOCOL).toBe("");
    expect(setupEnv({}).GIT_ALLOW_PROTOCOL).toBe(SAFE);
    expect(setupEnv({ GIT_ALLOW_PROTOCOL: "file:ext:ssh" }).GIT_ALLOW_PROTOCOL).toBe("file:ssh");
  });
});


describe("mandatory pin after caller-owned identity stripping", () => {
  it.each([["ext", ""], ["ext:https", "https"], [undefined, SAFE], ["", ""]])(
    "keeps the original caller restriction %j after stripping GIT_ fields",
    (value, expected) => {
      const { repo, marker } = extRemoteRepo();
      const env = gitChildEnv({ PATH: process.env.PATH, AGENT_CHAT_NAME: "fixture", GIT_ALLOW_PROTOCOL: value }, ["GIT_", "AGENT_CHAT_"]);
      const child = spawnSync("git", ["fetch", "x"], { cwd: repo, env, encoding: "utf8" });
      expect(fs.existsSync(marker)).toBe(false);
      expect(child.status).not.toBe(0);
      expect(child.stderr).toContain("transport 'ext' not allowed");
      expect(env.GIT_ALLOW_PROTOCOL).toBe(expected);
      expect(env.AGENT_CHAT_NAME).toBeUndefined();
    }
  );
});
