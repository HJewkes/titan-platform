import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempHome, removeTempHome } from "../fixtures/temp-home.js";
import { runCli } from "./cli.js";
import { launchdPlist, LAUNCHD_LABEL } from "./install-command.js";

const SHIPPED = path.resolve(import.meta.dirname, "../../systemd");
const UNITS = fs.readdirSync(SHIPPED);

let home: string;
let stdout: string[];
let calls: string[];

beforeEach(() => {
  home = makeTempHome();
  stdout = [];
  calls = [];
});

afterEach(() => removeTempHome(home));

function run(argv: string[], platform: NodeJS.Platform): Promise<number> {
  return runCli(argv, {
    env: {},
    home,
    platform,
    uid: 501,
    now: () => 0,
    exec: async (file, args) => void calls.push([file, ...args].join(" ")),
    out: (line) => stdout.push(line),
    err: (line) => stdout.push(line),
  });
}

const unitDir = (): string => path.join(home, ".config", "systemd", "user");
const plistPath = (): string => path.join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);

function filesUnder(dir: string): string[] {
  return fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).map(String) : [];
}

describe("install", () => {
  it("renders the three shipped systemd units byte-equal on linux and enables the timer", async () => {
    expect(await run(["install"], "linux")).toBe(0);

    expect(UNITS).toHaveLength(3);
    for (const name of UNITS) {
      expect(fs.readFileSync(path.join(unitDir(), name))).toEqual(fs.readFileSync(path.join(SHIPPED, name)));
    }
    expect(calls).toEqual(["systemctl --user daemon-reload", "systemctl --user enable --now anthropic-account-poll.timer"]);
  });

  it("renders the launchd plist golden on darwin and bootstraps it without --refresh", async () => {
    expect(await run(["install"], "darwin")).toBe(0);

    const plist = fs.readFileSync(plistPath(), "utf8");
    expect(plist).toBe(launchdPlist(home));
    expect(plist).toContain("<key>StartInterval</key><integer>150</integer>");
    expect(plist).toContain(`<string>${home}/.local/bin/anthropic-account</string>\n    <string>poll</string>\n    <string>--write</string>\n  </array>`);
    expect(plist).not.toContain("--refresh");
    expect(calls).toContain(`launchctl bootstrap gui/501 ${plistPath()}`);
  });

  it.each(["linux", "darwin"] as const)("writes no file and runs no command with --dry-run on %s", async (platform) => {
    expect(await run(["install", "--dry-run"], platform)).toBe(0);

    expect(filesUnder(home)).toEqual([]);
    expect(calls).toEqual([]);
    expect(stdout.join("\n")).toContain(platform === "linux" ? unitDir() : plistPath());
  });
});

describe("uninstall", () => {
  it("removes exactly the installed files and disables the timer on linux", async () => {
    await run(["install"], "linux");
    const written = filesUnder(home).sort();
    fs.writeFileSync(path.join(unitDir(), "unrelated.service"), "x");
    calls = [];

    expect(await run(["uninstall"], "linux")).toBe(0);

    expect(written).toHaveLength(3);
    expect(filesUnder(unitDir())).toEqual(["unrelated.service"]);
    expect(calls[0]).toBe("systemctl --user disable --now anthropic-account-poll.timer");
  });

  it("removes the plist and boots out the agent on darwin", async () => {
    await run(["install"], "darwin");
    calls = [];

    expect(await run(["uninstall"], "darwin")).toBe(0);

    expect(fs.existsSync(plistPath())).toBe(false);
    expect(calls).toEqual([`launchctl bootout gui/501/${LAUNCHD_LABEL}`]);
  });

  it("removes nothing and runs nothing with --dry-run", async () => {
    await run(["install"], "darwin");
    calls = [];

    expect(await run(["uninstall", "--dry-run"], "darwin")).toBe(0);

    expect(fs.existsSync(plistPath())).toBe(true);
    expect(calls).toEqual([]);
  });

  it("refuses an unknown flag with exit 64", async () => {
    expect(await run(["install", "--now"], "linux")).toBe(64);
    expect(calls).toEqual([]);
  });
});
