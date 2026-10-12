import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DispatchError } from "./dispatch.js";
import { assertInstalledHeadless, installedProfilesDir } from "./profile-guard.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-dispatch-profile-guard-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const install = (contents: string): void =>
  writeFileSync(join(dir, "implementer.json"), contents);

const refusal = (): Error | undefined => {
  try {
    assertInstalledHeadless("implementer", dir);
  } catch (err) {
    if (err instanceof Error) return err;
    throw err;
  }
  return undefined;
};

describe("assertInstalledHeadless", () => {
  it("accepts a profile whose surface is headless", () => {
    install(JSON.stringify({ surface: "headless", tools: ["Bash"] }));
    expect(() => assertInstalledHeadless("implementer", dir)).not.toThrow();
  });

  it.each([
    ["an interactive surface", JSON.stringify({ surface: "interactive" }), /surface "interactive"/],
    ["no surface at all", JSON.stringify({}), /surface missing/],
    ["a JSON value that is not an object", JSON.stringify("headless"), /surface missing/],
    ["text that is not JSON", "not json", /is not valid JSON/],
  ])("refuses %s, naming the profile and its path", (_label, contents, reason) => {
    install(contents);

    const err = refusal();

    expect(err).toBeInstanceOf(DispatchError);
    expect(err?.message).toMatch(reason);
    expect(err?.message).toContain(`'implementer'`);
    expect(err?.message).toContain(join(dir, "implementer.json"));
  });

  it("refuses a profile that is not installed", () => {
    expect(refusal()?.message).toMatch(/'implementer' is unreadable/);
  });

  it("never echoes an unexpected surface value from the file", () => {
    install(JSON.stringify({ surface: "SECRET-TOKEN-abc123 interactive" }));
    const message = refusal()?.message;
    expect(message).toContain("surface of type string");
    expect(message).not.toContain("SECRET-TOKEN");
  });

  it("refuses a traversal name before reading the file it points at", () => {
    const profilesDir = join(dir, "profiles");
    mkdirSync(profilesDir);
    install(JSON.stringify({ surface: "headless" }));

    expect(() => assertInstalledHeadless("../implementer", profilesDir)).toThrow(
      /invalid profile name/,
    );
  });

  it.each(["Implementer", "a/b", "", ".hidden"])("refuses the malformed name %j", (name) => {
    expect(() => assertInstalledHeadless(name, dir)).toThrow(DispatchError);
    expect(() => assertInstalledHeadless(name, dir)).toThrow(/invalid profile name/);
  });

  it.each(["headless-reviewer", "impl_v1.2"])("accepts the well-formed name %j when installed headless", (name) => {
    writeFileSync(join(dir, `${name}.json`), JSON.stringify({ surface: "headless" }));
    expect(() => assertInstalledHeadless(name, dir)).not.toThrow();
  });
});

describe("installedProfilesDir", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("is agent-chat's profiles directory under HOME", () => {
    vi.stubEnv("HOME", dir);
    vi.stubEnv("AGENT_CHAT_HOME", undefined);
    expect(installedProfilesDir()).toBe(join(dir, ".agent-chat", "profiles"));
  });

  it("is AGENT_CHAT_HOME's profiles directory when that is set", () => {
    vi.stubEnv("HOME", dir);
    vi.stubEnv("AGENT_CHAT_HOME", join(dir, "chat"));
    expect(installedProfilesDir()).toBe(join(dir, "chat", "profiles"));
  });

  it("falls back to HOME when AGENT_CHAT_HOME is empty", () => {
    vi.stubEnv("HOME", dir);
    vi.stubEnv("AGENT_CHAT_HOME", "");
    expect(installedProfilesDir()).toBe(join(dir, ".agent-chat", "profiles"));
  });

  it("falls back to the account's home directory when HOME is empty", () => {
    vi.stubEnv("HOME", "");
    vi.stubEnv("AGENT_CHAT_HOME", undefined);
    expect(installedProfilesDir()).toBe(join(homedir(), ".agent-chat", "profiles"));
  });
});
