import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitChildEnv, pinGitProtocols, runGit, withPinnedGitProtocols } from "./git.js";
import { setupEnv } from "./setup.js";

// Relevant engine cases lifted from the dispatcher's CC-1095 git-protocol-pin suite.
const LEGACY = "file:git:http:https:ssh";
const EXT_NEVER = { GIT_CONFIG_KEY_0: "protocol.ext.allow", GIT_CONFIG_VALUE_0: "never", GIT_CONFIG_COUNT: "1" };
// A git wrapper earlier on PATH (an agent's protocol shim) could pin protocols itself; git's exec dir holds the real one.
const REAL_GIT_PATH = `${execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim()}${path.delimiter}${process.env.PATH ?? ""}`;
const dirs: string[] = [];
function scratch(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "git-pin-")));
  dirs.push(dir);
  return dir;
}
/** A repo under its own HOME, so no host config file joins the fixture's. */
function scratchRepo(config: Record<string, string>, remote: string): { repo: string; home: string } {
  const home = scratch(), repo = path.join(home, "r");
  const git = (...args: string[]): void => {
    execFileSync("git", args, { cwd: home, env: { PATH: REAL_GIT_PATH, HOME: home, GIT_CONFIG_NOSYSTEM: "1" }, stdio: "ignore" });
  };
  git("init", "--quiet", repo);
  for (const [key, value] of Object.entries(config)) git("-C", repo, "config", key, value);
  git("-C", repo, "remote", "add", "x", remote);
  return { repo, home };
}
function extRemoteRepo(config: Record<string, string> = { "protocol.ext.allow": "always" }): { repo: string; home: string; marker: string } {
  const marker = path.join(scratch(), "marker");
  return { ...scratchRepo(config, `ext::sh -c touch% ${marker}`), marker };
}
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe("pinGitProtocols", () => {
  it.each([
    [undefined, undefined], [LEGACY, undefined], ["ext", ""], ["https:ext:ssh", "https:ssh"], ["EXT:https", "https"],
    ["next:https", "https"], ["HTTPS:sshx", ""], ["", ""], ["https", "https"], ["ssh:https:http:git:file", "ssh:https:http:git:file"],
  ])("narrows %j to %j", (value, pinned) => {
    expect(pinGitProtocols(value)).toBe(pinned);
  });
  it("drops the legacy list and appends the ext pair without otherwise rewriting the environment", () => {
    expect(withPinnedGitProtocols({ PATH: "/bin", GIT_ALLOW_PROTOCOL: LEGACY })).toEqual({ PATH: "/bin", ...EXT_NEVER });
    expect(withPinnedGitProtocols({ PATH: "/bin", GIT_ALLOW_PROTOCOL: "ext:ssh" }))
      .toEqual({ PATH: "/bin", GIT_ALLOW_PROTOCOL: "ssh", ...EXT_NEVER });
  });
  it("keeps caller config pairs and appends the ext pair after them, once", () => {
    const caller = { GIT_CONFIG_KEY_0: "core.sshCommand", GIT_CONFIG_VALUE_0: "fixture-ssh", GIT_CONFIG_COUNT: "01" };
    const pinned = withPinnedGitProtocols(caller);
    expect(pinned).toEqual({
      ...caller, GIT_CONFIG_KEY_1: "protocol.ext.allow", GIT_CONFIG_VALUE_1: "never", GIT_CONFIG_COUNT: "2",
    });
    expect(withPinnedGitProtocols(pinned)).toEqual(pinned);
    expect(withPinnedGitProtocols(EXT_NEVER)).toEqual(EXT_NEVER);
  });
  it.each([
    [{ GIT_CONFIG_COUNT: "x" }], [{ GIT_CONFIG_COUNT: "-1" }], [{ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "a.b" }],
  ])("refuses a config count git would die on: %j", (env) => {
    expect(() => withPinnedGitProtocols(env)).toThrow(/GIT_CONFIG_COUNT/);
  });
  it("appends the ext pair after a GIT_ strip, at index 0, and keeps identity stripping", () => {
    expect(gitChildEnv({ AGENT_CHAT_NAME: "fixture", GIT_ALLOW_PROTOCOL: "ext:https", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "a.b", GIT_CONFIG_VALUE_0: "c" }, ["GIT_", "AGENT_CHAT_"]))
      .toEqual({ GIT_ALLOW_PROTOCOL: "https", ...EXT_NEVER });
    expect(gitChildEnv({ PRIVATE_ID: "fixture", GIT_ALLOW_PROTOCOL: "" }, ["PRIVATE_"]))
      .toEqual({ GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: "", ...EXT_NEVER });
  });
});

describe("git the allocator runs itself", () => {
  const KEYS = ["PATH", "HOME", "GIT_ALLOW_PROTOCOL"] as const;
  let saved: Partial<Record<(typeof KEYS)[number], string>>;
  beforeEach(() => { saved = Object.fromEntries(KEYS.map(key => [key, process.env[key]])); });
  afterEach(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });
  it.each([["ext"], [undefined], [LEGACY]])("never runs a scratch ext remote when the host has GIT_ALLOW_PROTOCOL=%j", async value => {
    const { repo, home, marker } = extRemoteRepo({ "protocol.ext.allow": "always", "protocol.allow": "always" });
    process.env.PATH = REAL_GIT_PATH;
    process.env.HOME = home;
    if (value === undefined) delete process.env.GIT_ALLOW_PROTOCOL;
    else process.env.GIT_ALLOW_PROTOCOL = value;
    const out = await runGit(["fetch", "x"], repo);
    expect(out).toBeNull();
    expect(fs.existsSync(marker)).toBe(false);
  });
});

describe("worktree setup environment", () => {
  it("pins the install environment using the same policy", () => {
    expect(setupEnv({ GIT_ALLOW_PROTOCOL: "ext" }).GIT_ALLOW_PROTOCOL).toBe("");
    expect(setupEnv({ GIT_ALLOW_PROTOCOL: "file:ext:ssh" }).GIT_ALLOW_PROTOCOL).toBe("file:ssh");
    for (const value of [undefined, LEGACY]) {
      const env = setupEnv({ GIT_ALLOW_PROTOCOL: value });
      expect("GIT_ALLOW_PROTOCOL" in env).toBe(false);
      expect(env).toMatchObject(EXT_NEVER);
    }
  });
});

describe("mandatory pin after caller-owned identity stripping", () => {
  it.each([["ext", ""], ["ext:https", "https"], [undefined, undefined], [LEGACY, undefined], ["", ""]])(
    "never runs an ext remote with GIT_ALLOW_PROTOCOL=%j after stripping GIT_ fields",
    (value, expected) => {
      const { repo, home, marker } = extRemoteRepo();
      const env = gitChildEnv({ PATH: REAL_GIT_PATH, HOME: home, AGENT_CHAT_NAME: "fixture", GIT_ALLOW_PROTOCOL: value }, ["GIT_", "AGENT_CHAT_"]);
      const child = spawnSync("git", ["fetch", "x"], { cwd: repo, env, encoding: "utf8" });
      expect(fs.existsSync(marker)).toBe(false);
      expect(child.status).not.toBe(0);
      expect(child.stderr).toContain("transport 'ext' not allowed");
      expect(env.GIT_ALLOW_PROTOCOL).toBe(expected);
      expect(env.AGENT_CHAT_NAME).toBeUndefined();
    }
  );
});

describe("the caller's own protocol policy under gitChildEnv", () => {
  /** An ssh fetch whose caller-pair sshCommand leaves a marker when git lets the transport run. */
  function sshFetch(repoConfig: Record<string, string>, host: string | undefined): { ran: boolean; stderr: string } {
    const marker = path.join(scratch(), "marker");
    const { repo, home } = scratchRepo(repoConfig, "ssh://x.invalid/r");
    const env = gitChildEnv({
      PATH: REAL_GIT_PATH, HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_ALLOW_PROTOCOL: host,
      GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.sshCommand", GIT_CONFIG_VALUE_0: `touch '${marker}'; false`,
    });
    const child = spawnSync("git", ["fetch", "x"], { cwd: repo, env, encoding: "utf8" });
    expect(child.status).not.toBe(0);
    return { ran: fs.existsSync(marker), stderr: child.stderr };
  }

  it.each([[undefined], [LEGACY]])("still refuses an ssh fetch the repo denies, host GIT_ALLOW_PROTOCOL=%j", (host) => {
    const { ran, stderr } = sshFetch({ "protocol.ssh.allow": "never" }, host);
    expect(ran).toBe(false);
    expect(stderr).toContain("transport 'ssh' not allowed");
  });

  it("runs the caller's own config pair when nothing denies ssh", () => {
    expect(sshFetch({}, LEGACY).ran).toBe(true);
  });
});
