import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

const refusal = (): unknown => {
  try {
    assertInstalledHeadless("implementer", dir);
  } catch (err) {
    return err;
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
    expect((err as Error).message).toMatch(reason);
    expect((err as Error).message).toContain(`'implementer'`);
    expect((err as Error).message).toContain(join(dir, "implementer.json"));
  });

  it("refuses a profile that is not installed", () => {
    expect((refusal() as Error).message).toMatch(/'implementer' is unreadable/);
  });

  it("never echoes an unexpected surface value from the file", () => {
    install(JSON.stringify({ surface: "SECRET-TOKEN-abc123 interactive" }));
    const message = (refusal() as Error).message;
    expect(message).toContain("surface of type string");
    expect(message).not.toContain("SECRET-TOKEN");
  });
});

describe("installedProfilesDir", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("is agent-chat's profiles directory under HOME", () => {
    vi.stubEnv("HOME", dir);
    expect(installedProfilesDir()).toBe(join(dir, ".agent-chat", "profiles"));
  });

  it("falls back to the account's home directory when HOME is empty", () => {
    vi.stubEnv("HOME", "");
    expect(installedProfilesDir()).toBe(join(homedir(), ".agent-chat", "profiles"));
  });
});
