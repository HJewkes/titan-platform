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

  it("rejects an empty shepherd seats directory", () => {
    expect(() => loadConfig(configPath(xdg({ shepherd: { seatsDir: "" } })))).toThrow(/shepherd\.seatsDir/);
  });
});
