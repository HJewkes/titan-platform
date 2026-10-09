import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import oauthUsage from "../fixtures/oauth-usage.json" with { type: "json" };
import { CANARY, FAKE_ACCESS_TOKEN, HOUR, NOW, fakeCredentials } from "../fixtures/fake-tokens.js";
import { makeTempHome, removeTempHome, writeFileWithMode } from "../fixtures/temp-home.js";
import { CREDENTIALS_FILE } from "../node/login.js";
import type { FetchLike } from "../node/poll.js";
import { TOKEN_URL } from "../node/refresh.js";
import { usageFilePath } from "../node/usage-file.js";
import { runCli, type CliContext } from "./cli.js";
import { UNKNOWN_LINE } from "./statusline.js";

const uid = process.getuid?.() ?? 0;
const NEW_ACCESS_TOKEN = ["sk", "ant", "oat01", `${CANARY}renewed${"Zq9_".repeat(12)}`].join("-");

let home: string;
let stdout: string[];
let stderr: string[];
let calls: string[];

beforeEach(() => {
  home = makeTempHome();
  stdout = [];
  stderr = [];
  calls = [];
});

afterEach(() => {
  const printed = [...stdout, ...stderr].join("\n").toLowerCase();
  expect(printed).not.toContain(CANARY.toLowerCase());
  removeTempHome(home);
});

const configDir = (label: string): string =>
  label === "default" ? path.join(home, ".claude") : path.join(home, ".claude-profiles", label);

function login(label: string, credentials: unknown = fakeCredentials(), mode = 0o600): void {
  writeFileWithMode(path.join(configDir(label), CREDENTIALS_FILE), JSON.stringify(credentials), mode);
}

function emptyProfile(label: string): void {
  fs.mkdirSync(configDir(label), { recursive: true });
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const usageOk = (): Response => json(oauthUsage);

function fakeFetch(usage: () => Response, token: () => Response = () => json({}, 500)): FetchLike {
  return async (url) => {
    calls.push(url);
    return url === TOKEN_URL ? token() : usage();
  };
}

function run(argv: string[], fetch: FetchLike = fakeFetch(usageOk), env: CliContext["env"] = {}): Promise<number> {
  return runCli(argv, {
    env,
    home,
    fetch,
    now: () => NOW,
    uid,
    out: (line) => stdout.push(line),
    err: (line) => stderr.push(line),
  });
}

function writeReadingFile(label: string, five: number, weekly: number, ageSeconds: number): void {
  const reading = {
    session_id: "usage-poll",
    written_at: Math.floor(NOW / 1000) - ageSeconds,
    rate_limits: { five_hour: { used_percentage: five, resets_at: 1791478800 }, seven_day: { used_percentage: weekly } },
  };
  fs.mkdirSync(path.dirname(usageFilePath(configDir(label))), { recursive: true });
  fs.writeFileSync(usageFilePath(configDir(label)), JSON.stringify(reading));
}

describe("arguments", () => {
  it("prints the usage for --help and exits 0", async () => {
    expect(await run(["--help"])).toBe(0);
    expect(stdout.join("\n")).toContain("anthropic-account poll [--write [--refresh]]");
  });

  it.each([
    [["frobnicate"]],
    [[]],
    [["poll", "--refresh"]],
    [["poll", "--write", "--write"]],
    [["status", "--json", "--statusline"]],
    [["status", `--${CANARY}`]],
    [["poll", FAKE_ACCESS_TOKEN]],
  ])("refuses %j with exit 64 and never echoes an argument", async (argv) => {
    expect(await run(argv)).toBe(64);
    expect(stderr[0]).toMatch(/^anthropic-account: /);
    expect(calls).toEqual([]);
  });
});

describe("status", () => {
  it("prints each profile's login and newest reading and exits 0", async () => {
    login("default");
    writeReadingFile("default", 23, 41.5, 30);

    expect(await run(["status"])).toBe(0);

    expect(stdout).toEqual(["default: login present; five_hour 23%, seven_day 41.5% (age 30s)"]);
    expect(stderr).toEqual([]);
    expect(calls).toEqual([]);
  });

  it.each([
    ["missing", () => emptyProfile("agents"), "login missing"],
    ["expired", () => login("agents", fakeCredentials({ expiresAt: NOW - HOUR })), "login expired"],
    ["mode 0644", () => login("agents", fakeCredentials(), 0o644), "login refused (mode-too-wide)"],
  ])("exits 2 with one fixed stderr line when the login is %s", async (_case, arrange, text) => {
    login("default");
    arrange();

    expect(await run(["status"])).toBe(2);

    expect(stderr).toEqual([`anthropic-account: agents: ${text}`]);
  });

  it("prints JSON with the token-free login state and the windows", async () => {
    login("default");
    writeReadingFile("default", 23, 41.5, 30);
    emptyProfile("agents");

    expect(await run(["status", "--json"])).toBe(2);

    const [first, second] = JSON.parse(stdout.join("")).profiles;
    expect(first).toMatchObject({ label: "default", login: { status: "present", expiresAt: NOW + 2 * HOUR } });
    expect(first.usage).toMatchObject({ age_seconds: 30, rate_limits: { five_hour: { used_percentage: 23 } } });
    expect(second).toMatchObject({ label: "agents", login: { status: "missing" }, usage: null });
  });

  it("prints the status-line format for the current account and each other one", async () => {
    login("default");
    writeReadingFile("default", 23.9, 41.5, 30);
    writeReadingFile("agents", 5, 60, 90);
    emptyProfile("workout");

    expect(await run(["status", "--statusline"])).toBe(0);

    expect(stdout).toEqual(["23|41|1791478800||||||30", "other|agents|5|60|90|"]);
  });

  it("prints unknown for the status line and exits 0 with no stderr when nothing is readable", async () => {
    emptyProfile("agents");

    expect(await run(["status", "--statusline"], undefined, { CLAUDE_CONFIG_DIR: configDir("agents") })).toBe(0);

    expect(stdout).toEqual([UNKNOWN_LINE]);
    expect(stderr).toEqual([]);
  });
});

describe("poll", () => {
  it("prints each reading without writing it", async () => {
    login("default");

    expect(await run(["poll"])).toBe(0);

    expect(stdout).toEqual(["default: five_hour 23%, seven_day 41.5%, seven_day_opus 0%"]);
    expect(fs.existsSync(usageFilePath(configDir("default")))).toBe(false);
  });

  it("writes usage-poll.json with --write", async () => {
    login("default");

    expect(await run(["poll", "--write"])).toBe(0);

    expect(stdout[0]).toMatch(/ \(written\)$/);
    expect(JSON.parse(fs.readFileSync(usageFilePath(configDir("default")), "utf8"))).toMatchObject({
      session_id: "usage-poll",
      account: "default",
    });
  });

  it("exits 2 without a request when a login is expired", async () => {
    login("default", fakeCredentials({ expiresAt: NOW - HOUR }));

    expect(await run(["poll", "--write"])).toBe(2);

    expect(stderr).toEqual(["anthropic-account: default: login expired"]);
    expect(calls).toEqual([]);
  });

  it.each([
    ["an HTTP error", () => json({ echoed: FAKE_ACCESS_TOKEN }, 401), "poll failed: http-401"],
    [
      "a fetch that throws the token",
      () => {
        throw new Error(`refused Bearer ${FAKE_ACCESS_TOKEN}`);
      },
      "poll failed: network",
    ],
  ])("exits 1 with a fixed line on %s", async (_case, usage, text) => {
    login("default");

    expect(await run(["poll", "--write"], fakeFetch(usage))).toBe(1);

    expect(stderr).toEqual([`anthropic-account: default: ${text}`]);
  });
});

describe("poll --write --refresh", () => {
  const dueSoon = (): Record<string, unknown> => fakeCredentials({ expiresAt: NOW + 5 * 60_000 });
  const granted = (): Response => json({ access_token: NEW_ACCESS_TOKEN, expires_in: 28_800 });

  it("renews a token due within the margin, writes the credentials file, then polls", async () => {
    login("default", dueSoon());

    expect(await run(["poll", "--write", "--refresh"], fakeFetch(usageOk, granted))).toBe(0);

    expect(calls).toEqual([TOKEN_URL, "https://api.anthropic.com/api/oauth/usage"]);
    expect(stdout[0]).toBe("default: token refreshed");
    const stored = JSON.parse(fs.readFileSync(path.join(configDir("default"), CREDENTIALS_FILE), "utf8"));
    expect(stored.claudeAiOauth.accessToken).toBe(NEW_ACCESS_TOKEN);
    expect(stored.claudeAiOauth.expiresAt).toBe(NOW + 28_800_000);
  });

  it("leaves a token that is not due alone", async () => {
    login("default");

    expect(await run(["poll", "--write", "--refresh"], fakeFetch(usageOk, granted))).toBe(0);

    expect(calls).toEqual(["https://api.anthropic.com/api/oauth/usage"]);
  });

  it("reports a failed refresh with a fixed line and exit 1, and still polls", async () => {
    login("default", dueSoon());

    expect(await run(["poll", "--write", "--refresh"])).toBe(1);

    expect(stderr).toEqual(["anthropic-account: default: token refresh failed: http-500"]);
    expect(fs.existsSync(usageFilePath(configDir("default")))).toBe(true);
  });
});
