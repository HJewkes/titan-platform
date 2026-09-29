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
  it("reads the shepherd seats directory and charter path", () => {
    const env = xdg({ shepherd: { seatsDir: "/seats", charterPath: "/charter.md" } });

    expect(loadConfig(configPath(env)).shepherd).toEqual({ seatsDir: "/seats", charterPath: "/charter.md" });
  });

  it("rejects an empty shepherd seats directory", () => {
    expect(() => loadConfig(configPath(xdg({ shepherd: { seatsDir: "" } })))).toThrow(/shepherd\.seatsDir/);
  });
});
