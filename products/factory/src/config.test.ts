import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { configPath, loadConfig, resolveDbPath } from "./config.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function xdg(config?: unknown): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), "factory-config-"));
  dirs.push(dir);
  if (config !== undefined) {
    mkdirSync(join(dir, "config", "titan-factory"), { recursive: true });
    writeFileSync(join(dir, "config", "titan-factory", "config.json"), JSON.stringify(config));
  }
  return { XDG_CONFIG_HOME: join(dir, "config"), XDG_STATE_HOME: join(dir, "state") };
}

describe("resolveDbPath", () => {
  it("prefers the flag, then the environment, then the config file", () => {
    const env = { ...xdg({ dbPath: "/from/config" }), TITAN_FACTORY_DB: "/from/env" };

    expect(resolveDbPath({ env, dbFlag: "/from/flag" })).toBe("/from/flag");
    expect(resolveDbPath({ env })).toBe("/from/env");
    expect(resolveDbPath({ env: { ...env, TITAN_FACTORY_DB: undefined } })).toBe("/from/config");
  });

  it("falls back to the XDG state directory when nothing is configured", () => {
    const env = xdg();

    expect(resolveDbPath({ env })).toBe(join(env.XDG_STATE_HOME!, "titan-factory", "factory.sqlite3"));
  });

  it("rejects a config file with the wrong shape", () => {
    expect(() => resolveDbPath({ env: xdg({ dbPath: 3 }) })).toThrow(/invalid config .*dbPath/);
  });
});

describe("loadConfig", () => {
  it("names the config path when the file is not valid JSON", () => {
    const env = xdg({});
    writeFileSync(configPath(env), "{ not json");

    expect(() => loadConfig(configPath(env))).toThrow(new RegExp(`invalid config .*${"titan-factory"}.config\\.json`));
  });

  it("reads the shepherd seats directory and charter path", () => {
    const env = xdg({ shepherd: { seatsDir: "/seats", charterPath: "/charter.md" } });

    expect(loadConfig(configPath(env)).shepherd).toEqual({ seatsDir: "/seats", charterPath: "/charter.md" });
  });

  it("reads the repos each charter hard stop forbids", () => {
    const env = xdg({ shepherd: { charterPath: "/charter.md", hardStopRepos: { "dotfiles-merge": ["acme/dotfiles"] } } });

    expect(loadConfig(configPath(env)).shepherd?.hardStopRepos).toEqual({ "dotfiles-merge": ["acme/dotfiles"] });
  });

  it("reads the digest copy dirs and still accepts the legacy icloudDir", () => {
    const env = xdg({ digest: { copyDirs: ["/a", "/b"], icloudDir: "/legacy" } });

    expect(loadConfig(configPath(env)).digest).toEqual({ copyDirs: ["/a", "/b"], icloudDir: "/legacy" });
  });

  it("refuses an unknown digest key", () => {
    expect(() => loadConfig(configPath(xdg({ digest: { copyDir: "/a" } })))).toThrow(/invalid config .*copyDir/);
  });

  it("rejects an empty checks list and a wait beyond the cap", () => {
    const flaky = (rule: object) => configPath(xdg({ shepherd: { flakyChecks: { "acme/web": rule } } }));

    expect(() => loadConfig(flaky({ checks: [], waitSeconds: 60 }))).toThrow(/flakyChecks/);
    expect(() => loadConfig(flaky({ checks: ["validate"], waitSeconds: 3600 }))).toThrow(/flakyChecks/);
  });

  it("reads each repo's flaky checks and wait, and rejects a repo that is not owner/name", () => {
    const flakyChecks = { "acme/web": { checks: ["validate"], waitSeconds: 60 } };

    expect(loadConfig(configPath(xdg({ shepherd: { flakyChecks } }))).shepherd?.flakyChecks).toEqual(flakyChecks);
    expect(() => loadConfig(configPath(xdg({ shepherd: { flakyChecks: { web: flakyChecks["acme/web"] } } })))).toThrow(/flakyChecks/);
  });

  it("reads the review-check App, and rejects a relative key path, a non-integer id and an unknown key", () => {
    const reviewCheck = { appId: 101, installationId: 202, privateKeyPath: "/keys/app.pem" };
    const load = (block: object) => loadConfig(configPath(xdg({ shepherd: { reviewCheck: block } })));

    expect(load(reviewCheck).shepherd?.reviewCheck).toEqual(reviewCheck);
    expect(() => load({ ...reviewCheck, privateKeyPath: "keys/app.pem" })).toThrow(/reviewCheck/);
    expect(() => load({ ...reviewCheck, appId: "101" })).toThrow(/reviewCheck/);
    expect(() => load({ ...reviewCheck, token: "x" })).toThrow(/reviewCheck/);
  });

  it.each(["https://github.com/acme/dotfiles", "acme/dotfiles.git"])("rejects %s as a hard-stop repo", (repo) => {
    expect(() => loadConfig(configPath(xdg({ shepherd: { charterPath: "/charter.md", hardStopRepos: { "dotfiles-merge": [repo] } } })))).toThrow(/hardStopRepos/);
  });

  it("rejects hard-stop repos configured without a charter path", () => {
    expect(() => loadConfig(configPath(xdg({ shepherd: { hardStopRepos: { "dotfiles-merge": ["acme/dotfiles"] } } })))).toThrow(/charterPath/);
  });

  it("reads the post-merge command as an argv array", () => {
    const env = xdg({ postMerge: { argv: ["chore", "--prune"], cwd: "/work", timeoutMs: 60_000 } });

    expect(loadConfig(configPath(env)).postMerge).toEqual({ argv: ["chore", "--prune"], cwd: "/work", timeoutMs: 60_000 });
  });

  it.each([
    ["a shell string argv", { argv: "chore --prune" }, /postMerge\.argv/],
    ["an empty argv", { argv: [] }, /postMerge\.argv/],
    ["an empty program", { argv: ["", "--prune"] }, /postMerge\.argv\.0/],
    ["a non-string entry", { argv: ["chore", 3] }, /postMerge\.argv\.1/],
    ["a negative timeout", { argv: ["chore"], timeoutMs: -1 }, /postMerge\.timeoutMs/],
    ["a fractional timeout", { argv: ["chore"], timeoutMs: 1.5 }, /postMerge\.timeoutMs/],
    ["a shell flag", { argv: ["chore"], shell: true }, /postMerge.*shell/],
    ["a relative cwd", { argv: ["chore"], cwd: "work/tree" }, /postMerge\.cwd: must be an absolute path/],
    ["a NUL in the program", { argv: ["chore\0x"] }, /postMerge\.argv\.0: must not contain a NUL/],
    ["a NUL in an argument", { argv: ["chore", "a\0b"] }, /postMerge\.argv\.1: must not contain a NUL/],
    ["a NUL in the cwd", { argv: ["chore"], cwd: "/work\0x" }, /postMerge\.cwd: must not contain a NUL/],
  ])("rejects a post-merge command with %s", (_label, postMerge, key) => {
    expect(() => loadConfig(configPath(xdg({ postMerge })))).toThrow(key);
  });

  it("reads the agent-chat binary and the reviewer it dispatches", () => {
    const review = { profile: "rv-readonly", configDir: "/srv/rv-claude", verdictTimeoutMs: 900_000, sessionStartTimeoutMs: 60_000 };
    const env = xdg({ shepherd: { agentChatBin: "/opt/bin/agent-chat", review } });

    expect(loadConfig(configPath(env)).shepherd).toEqual({ agentChatBin: "/opt/bin/agent-chat", review });
  });

  it("reads a reviewer role table and rejects a role profile with a slash", () => {
    const review = { profile: "bd-reviewer", roles: { g10: "bd-reviewer", standard: "reviewer" } };

    expect(loadConfig(configPath(xdg({ shepherd: { agentChatBin: "/opt/bin/agent-chat", review } }))).shepherd?.review).toEqual(review);
    expect(() => loadConfig(configPath(xdg({ shepherd: { agentChatBin: "/opt/bin/agent-chat", review: { profile: "rv", roles: { standard: "a/b" } } } })))).toThrow(/roles/);
  });

  it("rejects a role table naming a class that does not exist", () => {
    const review = { profile: "rv", roles: { critical: "bd-reviewer" } };

    expect(() => loadConfig(configPath(xdg({ shepherd: { agentChatBin: "/opt/bin/agent-chat", review } })))).toThrow(/roles/);
  });

  it("reads an agent-chat binary with no reviewer, and a reviewer that names only its profile", () => {
    expect(loadConfig(configPath(xdg({ shepherd: { agentChatBin: "/opt/bin/agent-chat" } }))).shepherd).toEqual({ agentChatBin: "/opt/bin/agent-chat" });
    expect(loadConfig(configPath(xdg({ shepherd: { agentChatBin: "/opt/bin/agent-chat", review: { profile: "rv" } } }))).shepherd?.review).toEqual({ profile: "rv" });
  });

  it.each(["agent-chat", "bin/agent-chat", "./agent-chat", "~/bin/agent-chat", ""])("rejects %j as the agent-chat binary, because it is not an absolute path", (agentChatBin) => {
    expect(() => loadConfig(configPath(xdg({ shepherd: { agentChatBin } })))).toThrow(/shepherd\.agentChatBin: must be an absolute path/);
  });

  it("rejects an agent-chat binary path that holds a NUL", () => {
    expect(() => loadConfig(configPath(xdg({ shepherd: { agentChatBin: "/opt/bin/agent\0chat" } })))).toThrow(/shepherd\.agentChatBin: must not contain a NUL/);
  });

  it("rejects a hub seat configured without an agent-chat binary", () => {
    expect(() => loadConfig(configPath(xdg({ shepherd: { hubSeat: "hub" } })))).toThrow(/shepherd\.agentChatBin: hubSeat needs an agentChatBin/);
  });

  it("rejects a reviewer configured without an agent-chat binary", () => {
    expect(() => loadConfig(configPath(xdg({ shepherd: { review: { profile: "rv-readonly" } } })))).toThrow(/shepherd\.agentChatBin: review needs an agentChatBin/);
  });

  it.each([
    ["an empty string", ""],
    ["a leading dash", "--dangerously-skip-permissions"],
    ["a space", "rv readonly"],
    ["a trailing space", "rv-readonly "],
    ["a tab", "rv\treadonly"],
    ["a newline", "rv\nreadonly"],
    ["a NUL", "rv\0readonly"],
    ["a slash", "../x"],
    ["a parent segment", "rv..x"],
    ["a path", "a/b"],
  ])("rejects a reviewer profile with %s, because it reaches the agent-chat argv as one argument", (_label, profile) => {
    expect(() => loadConfig(configPath(xdg({ shepherd: { agentChatBin: "/opt/bin/agent-chat", review: { profile } } })))).toThrow(/shepherd\.review\.profile: must/);
  });

  it.each([
    ["an empty string", ""],
    ["a leading dash", "--model"],
    ["a space", "/srv/rv claude"],
    ["a newline", "/srv/rv\nclaude"],
    ["a NUL", "/srv/rv\0claude"],
    ["a relative path", "rv-claude"],
    ["a tilde", "~/rv-claude"],
  ])("rejects a reviewer config directory with %s", (_label, configDir) => {
    expect(() => loadConfig(configPath(xdg({ shepherd: { agentChatBin: "/opt/bin/agent-chat", review: { profile: "rv-readonly", configDir } } })))).toThrow(/shepherd\.review\.configDir: must/);
  });

  it.each([
    ["no profile", {}, /shepherd\.review\.profile/],
    ["a zero verdict timeout", { profile: "rv", verdictTimeoutMs: 0 }, /shepherd\.review\.verdictTimeoutMs/],
    ["a fractional verdict timeout", { profile: "rv", verdictTimeoutMs: 1.5 }, /shepherd\.review\.verdictTimeoutMs/],
    ["a negative session-start timeout", { profile: "rv", sessionStartTimeoutMs: -1 }, /shepherd\.review\.sessionStartTimeoutMs/],
    ["a misspelt key", { profile: "rv", verdictTimeout: 60_000 }, /shepherd\.review.*verdictTimeout/],
  ])("rejects a reviewer with %s", (_label, review, key) => {
    expect(() => loadConfig(configPath(xdg({ shepherd: { agentChatBin: "/opt/bin/agent-chat", review } })))).toThrow(key);
  });

  it("rejects an empty shepherd seats directory", () => {
    expect(() => loadConfig(configPath(xdg({ shepherd: { seatsDir: "" } })))).toThrow(/shepherd\.seatsDir/);
  });
});
