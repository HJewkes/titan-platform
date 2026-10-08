import path from "node:path";
import envPaths from "env-paths";
import { describe, expect, it } from "vitest";
import { ACTIVE_WORK, activeWorkGraphPath, activeWorkRoot, appDataRoot, appDirs } from "./index.js";

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
