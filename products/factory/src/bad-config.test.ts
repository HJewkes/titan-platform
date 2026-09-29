import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const bin = fileURLToPath(new URL("../dist/bin.js", import.meta.url));
let home: string;
let configFile: string;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "factory-bad-config-"));
  mkdirSync(join(home, "config", "titan-factory"), { recursive: true });
  configFile = join(home, "config", "titan-factory", "config.json");
  writeFileSync(configFile, "{ not json");
});
afterAll(() => rmSync(home, { recursive: true, force: true }));

function run(...args: string[]) {
  const env = { ...process.env, XDG_CONFIG_HOME: join(home, "config"), XDG_STATE_HOME: join(home, "state") };
  delete env.TITAN_FACTORY_DB;
  return spawnSync(process.execPath, [bin, ...args], { env, encoding: "utf8", timeout: 30_000 });
}

describe.skipIf(!existsSync(bin))("titan-factory with a malformed config file", () => {
  it("prints help", () => {
    const result = run("--help");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage: titan-factory");
  });

  it("prints the service plist", () => {
    const result = run("service", "plist");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("<plist");
  });

  it("fails a database-opening command naming the config file", () => {
    const result = run("resume");

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(configFile);
  });
});
