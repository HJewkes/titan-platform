import path from "node:path";
import envPaths from "env-paths";
import { describe, expect, it } from "vitest";
import { ACTIVE_WORK, activeWorkGraphPath, activeWorkRoot, appDataRoot, appDirs, consoleInboxDir, scorecardStorePath } from "./index.js";

const home = path.join(path.sep, "home", "user");

describe("activeWorkRoot with ACTIVE_ROOT set", () => {
  const rootFor = (value: string) => activeWorkRoot({ env: { ACTIVE_ROOT: value }, home, platform: "linux" });

  it("returns an absolute override as given", () => {
    expect(rootFor(path.join(path.sep, "srv", "aw"))).toBe(path.join(path.sep, "srv", "aw"));
  });

  it("expands a bare tilde to the home directory", () => {
    expect(rootFor("~")).toBe(home);
  });

  it("expands a leading tilde-slash under the home directory", () => {
    expect(rootFor("~/aw-data")).toBe(path.join(home, "aw-data"));
  });

  it("resolves a relative override against the working directory", () => {
    expect(rootFor("aw-data")).toBe(path.resolve("aw-data"));
  });
});

describe("activeWorkRoot defaults", () => {
  it("ignores an empty ACTIVE_ROOT", () => {
    const root = activeWorkRoot({ env: { ACTIVE_ROOT: "" }, home, platform: "linux" });
    expect(root).toBe(path.join(home, ".local", "share", "active-work"));
  });

  it("uses Application Support on darwin even when XDG_DATA_HOME is set", () => {
    const root = activeWorkRoot({ env: { XDG_DATA_HOME: path.join(home, "xdg") }, home, platform: "darwin" });
    expect(root).toBe(path.join(home, "Library", "Application Support", "active-work"));
  });

  it("uses XDG_DATA_HOME on linux when set", () => {
    const root = activeWorkRoot({ env: { XDG_DATA_HOME: path.join(home, "xdg") }, home, platform: "linux" });
    expect(root).toBe(path.join(home, "xdg", "active-work"));
  });

  it("falls back to ~/.local/share on linux when XDG_DATA_HOME is unset or empty", () => {
    const expected = path.join(home, ".local", "share", "active-work");
    expect(activeWorkRoot({ env: {}, home, platform: "linux" })).toBe(expected);
    expect(activeWorkRoot({ env: { XDG_DATA_HOME: "" }, home, platform: "linux" })).toBe(expected);
  });

  it("uses LOCALAPPDATA on win32", () => {
    const root = activeWorkRoot({ env: { LOCALAPPDATA: path.join(home, "local") }, home, platform: "win32" });
    expect(root).toBe(path.join(home, "local", "active-work", "Data"));
  });

  it("falls back to AppData/Local on win32 when LOCALAPPDATA is unset", () => {
    const root = activeWorkRoot({ env: {}, home, platform: "win32" });
    expect(root).toBe(path.join(home, "AppData", "Local", "active-work", "Data"));
  });
});

describe("activeWorkGraphPath", () => {
  it("places the graph under the root's .miner directory", () => {
    const graph = activeWorkGraphPath({ env: { ACTIVE_ROOT: "~/aw" }, home, platform: "darwin" });
    expect(graph).toBe(path.join(home, "aw", ".miner", "graph.sqlite3"));
  });
});

describe("appDataRoot", () => {
  it("reads the override variable the spec names", () => {
    const app = { name: "demo", overrideVar: "DEMO_ROOT" };
    const opts = { env: { DEMO_ROOT: "~/d", ACTIVE_ROOT: "/ignored" }, home, platform: "linux" as const };
    expect(appDataRoot(app, opts)).toBe(path.join(home, "d"));
    expect(appDataRoot(ACTIVE_WORK, { ...opts, env: {} })).toBe(path.join(home, ".local", "share", "active-work"));
  });
});

describe("appDirs parity with env-paths on the host", () => {
  it.each(["active-work", "app-paths-parity"])("matches env-paths for %s", (name) => {
    const { data, config, cache, log } = envPaths(name, { suffix: "" });
    expect(appDirs(name)).toEqual({ data, config, cache, log });
  });
});

describe("consoleInboxDir", () => {
  const inboxFor = (env: Record<string, string>) => consoleInboxDir({ env, home });

  it("expands a tilde in TITAN_CONSOLE_INBOX_DIR, ahead of the state directory", () => {
    expect(inboxFor({ TITAN_CONSOLE_INBOX_DIR: "~/inbox", TITAN_CONSOLE_STATE: "~/state" })).toBe(path.join(home, "inbox"));
  });

  it("falls back to inbox/deposits under a tilde TITAN_CONSOLE_STATE", () => {
    expect(inboxFor({ TITAN_CONSOLE_STATE: "~/state" })).toBe(path.join(home, "state", "inbox", "deposits"));
  });

  it("treats an empty TITAN_CONSOLE_INBOX_DIR as unset", () => {
    expect(inboxFor({ TITAN_CONSOLE_INBOX_DIR: "" })).toBe(path.join(home, ".local", "state", "titan-console", "inbox", "deposits"));
  });

  it("leaves an absolute override as given", () => {
    expect(inboxFor({ TITAN_CONSOLE_INBOX_DIR: path.join(path.sep, "srv", "spool") })).toBe(path.join(path.sep, "srv", "spool"));
  });
});

describe("scorecardStorePath", () => {
  const storeFor = (env: Record<string, string>) => scorecardStorePath({ env, home });

  it("expands a tilde in TITAN_SCORECARD_STORE", () => {
    expect(storeFor({ TITAN_SCORECARD_STORE: "~/sc/store.sqlite3" })).toBe(path.join(home, "sc", "store.sqlite3"));
  });

  it("defaults under the home data directory", () => {
    expect(storeFor({})).toBe(path.join(home, ".local", "share", "titan-scorecard", "scorecard.sqlite3"));
  });

  it("follows XDG_DATA_HOME when set", () => {
    expect(storeFor({ XDG_DATA_HOME: path.join(path.sep, "data") })).toBe(path.join(path.sep, "data", "titan-scorecard", "scorecard.sqlite3"));
  });
});
