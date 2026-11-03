import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import oauthUsage from "../fixtures/oauth-usage.json" with { type: "json" };
import { CANARY, FAKE_ACCESS_TOKEN, HOUR, NOW, fakeCredentials } from "../fixtures/fake-tokens.js";
import { captureOutput, errorText, makeTempHome, removeTempHome, thrown } from "../fixtures/temp-home.js";
import { keychainService, type KeychainExec } from "./keychain.js";
import { readLoginState } from "./login.js";
import { USAGE_URL, pollUsage, type FetchLike } from "./poll.js";

let home: string;
let output: ReturnType<typeof captureOutput>;
let execs: (readonly string[])[];

beforeEach(() => {
  home = makeTempHome();
  output = captureOutput();
  execs = [];
});

afterEach(() => {
  output.restore();
  removeTempHome(home);
});

const NOT_FOUND = 44;

function stubExec(status: number, stdout: string, stderr = ""): KeychainExec {
  return (file, args) => {
    execs.push([file, ...args]);
    return { status, stdout: Buffer.from(stdout), stderr: Buffer.from(stderr) };
  };
}

const keychainOf = (credentials: unknown = fakeCredentials()): KeychainExec =>
  stubExec(0, `${JSON.stringify(credentials)}\n`);

const darwin = (keychainExec: KeychainExec) => ({ platform: "darwin" as const, home, keychainExec, now: NOW });

function expectNoCanary(...values: unknown[]): void {
  for (const value of values) expect(`${JSON.stringify(value)} ${errorText(value)}`).not.toContain(CANARY);
  expect(output.text()).not.toContain(CANARY);
  const files = fs.readdirSync(home, { recursive: true, encoding: "utf8" });
  for (const file of files) {
    const full = path.join(home, file);
    if (fs.statSync(full).isFile()) expect(fs.readFileSync(full, "utf8")).not.toContain(CANARY);
  }
}

describe("keychainService", () => {
  it("the default config dir reads the bare Claude Code-credentials service", () => {
    expect(keychainService("/home/user/.claude", "/home/user")).toBe("Claude Code-credentials");
    expect(keychainService("/home/user/.claude/", "/home/user")).toBe("Claude Code-credentials");
  });

  it("a named config dir appends the first eight hex of its path's sha256", () => {
    const service = keychainService("/home/user/.claude-profiles/work", "/home/user");

    expect(service).toBe("Claude Code-credentials-2de813ec");
  });
});

describe("readLoginState on darwin", () => {
  it("a darwin login read from the Keychain is present and carries no token", () => {
    const configDir = path.join(home, ".claude-profiles", "work");

    const state = readLoginState(configDir, darwin(keychainOf()));

    expect(state).toEqual({
      status: "present",
      expiresAt: NOW + 2 * HOUR,
      canRefresh: true,
      subscriptionType: "max",
      rateLimitTier: "default_claude_max_20x",
    });
    expect(execs).toEqual([
      ["/usr/bin/security", "find-generic-password", "-s", keychainService(configDir, home), "-w"],
    ]);
    expectNoCanary(state);
  });

  it("a missing Keychain item reports missing", () => {
    const state = readLoginState(path.join(home, ".claude"), darwin(stubExec(NOT_FOUND, "", `no item ${CANARY}`)));

    expect(state).toEqual({ status: "missing" });
    expectNoCanary(state);
  });

  it("a failing security run throws a fixed message that echoes neither stream", () => {
    // A bare canary as well as a token: redactSecrets would mask only the token-shaped one.
    const exec = stubExec(1, `${CANARY} ${FAKE_ACCESS_TOKEN}`, `denied ${CANARY} ${FAKE_ACCESS_TOKEN}`);

    const error = thrown(() => readLoginState(path.join(home, ".claude"), darwin(exec)));

    expect(errorText(error)).toContain("reading the Keychain item failed");
    expectNoCanary(error);
  });

  it("an exec that throws a canary is reported with the fixed message", () => {
    const exec: KeychainExec = () => {
      throw new Error(`spawn failed ${CANARY} ${FAKE_ACCESS_TOKEN}`);
    };

    const error = thrown(() => readLoginState(path.join(home, ".claude"), darwin(exec)));

    expect(errorText(error)).toContain("reading the Keychain item failed");
    expectNoCanary(error);
  });

  it("linux still reads the credentials file and never runs security", () => {
    const state = readLoginState(path.join(home, ".claude"), { ...darwin(keychainOf()), platform: "linux" });

    expect(state).toEqual({ status: "missing" });
    expect(execs).toEqual([]);
  });
});

describe("pollUsage on darwin", () => {
  const profile = (): { label: string; configDir: string } => ({ label: "work", configDir: path.join(home, ".claude") });

  function recordingFetch(urls: string[], seen: string[]): FetchLike {
    return async (url, init) => {
      urls.push(url);
      seen.push(new Headers(init.headers).get("authorization") ?? "");
      return new Response(JSON.stringify(oauthUsage), { status: 200 });
    };
  }

  it("polls with the Keychain token and sends it only to the usage endpoint", async () => {
    const urls: string[] = [];
    const auth: string[] = [];

    const result = await pollUsage(profile(), { ...darwin(keychainOf()), fetch: recordingFetch(urls, auth) });

    expect(result.ok).toBe(true);
    expect(urls).toEqual([USAGE_URL]);
    expect(auth).toEqual([`Bearer ${FAKE_ACCESS_TOKEN}`]);
    expectNoCanary(result);
  });

  it("an expired Keychain token is expired and sends no request", async () => {
    const urls: string[] = [];
    const exec = keychainOf(fakeCredentials({ expiresAt: NOW + 30_000 }));

    const result = await pollUsage(profile(), { ...darwin(exec), fetch: recordingFetch(urls, []) });

    expect(result).toEqual({ ok: false, failure: "expired" });
    expect(urls).toEqual([]);
  });

  it("a non-zero security exit polls as io with nothing echoed", async () => {
    const urls: string[] = [];
    const exec = stubExec(51, `${CANARY} ${FAKE_ACCESS_TOKEN}`, `denied ${CANARY} ${FAKE_ACCESS_TOKEN}`);

    const result = await pollUsage(profile(), { ...darwin(exec), fetch: recordingFetch(urls, []) });

    expect(result).toEqual({ ok: false, failure: "io" });
    expect(urls).toEqual([]);
    expectNoCanary(result);
  });
});
