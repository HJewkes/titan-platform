import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CANARY, FAKE_ACCESS_TOKEN, HOUR, NOW, fakeCredentials } from "../fixtures/fake-tokens.js";
import {
  captureOutput,
  errorText,
  makeTempHome,
  removeTempHome,
  thrown,
  writeFileWithMode,
} from "../fixtures/temp-home.js";
import { CREDENTIALS_FILE, MAX_CREDENTIALS_BYTES, readLoginState } from "./login.js";

const uid = process.getuid?.() ?? 0;

let home: string;
let configDir: string;
let credentials: string;
let output: ReturnType<typeof captureOutput>;

beforeEach(() => {
  home = makeTempHome();
  configDir = path.join(home, ".claude");
  credentials = path.join(configDir, CREDENTIALS_FILE);
  output = captureOutput();
});

afterEach(() => {
  output.restore();
  vi.restoreAllMocks();
  removeTempHome(home);
});

function writeCredentials(value: unknown, mode = 0o600): void {
  writeFileWithMode(credentials, typeof value === "string" ? value : JSON.stringify(value), mode);
}

function expectNoCanary(...values: unknown[]): void {
  for (const value of values) expect(JSON.stringify(value) ?? "").not.toContain(CANARY);
  expect(output.text()).not.toContain(CANARY);
}

describe("readLoginState on a well-formed credentials file", () => {
  it("reports a present login with no token in it", () => {
    writeCredentials(fakeCredentials());

    const state = readLoginState(configDir, { now: NOW, uid });

    expect(state).toEqual({
      status: "present",
      expiresAt: NOW + 2 * HOUR,
      canRefresh: true,
      subscriptionType: "max",
      rateLimitTier: "default_claude_max_20x",
    });
    expectNoCanary(state);
  });

  it("reports an expired login", () => {
    writeCredentials(fakeCredentials({ expiresAt: NOW - HOUR }));

    const state = readLoginState(configDir, { now: NOW, uid });

    expect(state).toEqual({ status: "expired", expiresAt: NOW - HOUR, canRefresh: true });
    expectNoCanary(state);
  });

  it("accepts an owner-only mode with the execute bit", () => {
    writeCredentials(fakeCredentials(), 0o700);

    expect(readLoginState(configDir, { now: NOW, uid }).status).toBe("present");
  });

  it("checks against this process's uid by default", () => {
    writeCredentials(fakeCredentials());

    expect(readLoginState(configDir, { now: NOW }).status).toBe("present");
  });
});

describe("readLoginState when there is nothing to read", () => {
  it("reports missing for a config dir with no credentials file", () => {
    fs.mkdirSync(configDir);

    expect(readLoginState(configDir, { now: NOW, uid })).toEqual({ status: "missing" });
  });

  it("reports missing for a config dir that does not exist", () => {
    expect(readLoginState(configDir, { now: NOW, uid })).toEqual({ status: "missing" });
  });
});

describe("readLoginState refuses before reading a byte", () => {
  it.each([0o644, 0o640, 0o604, 0o660, 0o666, 0o610, 0o601])("refuses mode %o", (mode) => {
    writeCredentials(fakeCredentials(), mode);
    const read = vi.spyOn(fs, "readSync");

    const state = readLoginState(configDir, { now: NOW, uid });

    expect(state).toEqual({ status: "refused", reason: "mode-too-wide" });
    expect(read).not.toHaveBeenCalled();
    expectNoCanary(state);
  });

  it("refuses a file another user owns", () => {
    writeCredentials(fakeCredentials());
    const read = vi.spyOn(fs, "readSync");

    const state = readLoginState(configDir, { now: NOW, uid: uid + 1 });

    expect(state).toEqual({ status: "refused", reason: "foreign-owner" });
    expect(read).not.toHaveBeenCalled();
  });

  it("refuses a symlink even to an owner-only file", () => {
    const target = path.join(home, "elsewhere.json");
    writeFileWithMode(target, JSON.stringify(fakeCredentials()), 0o600);
    fs.mkdirSync(configDir);
    fs.symlinkSync(target, credentials);
    const open = vi.spyOn(fs, "openSync");
    const read = vi.spyOn(fs, "readSync");

    const state = readLoginState(configDir, { now: NOW, uid });

    expect(state).toEqual({ status: "refused", reason: "not-a-regular-file" });
    expect(open).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it("refuses a directory in the credentials file's place", () => {
    fs.mkdirSync(credentials, { recursive: true });

    expect(readLoginState(configDir, { now: NOW, uid })).toEqual({ status: "refused", reason: "not-a-regular-file" });
  });
});

describe("readLoginState checks the descriptor it reads", () => {
  const realOpen = fs.openSync;

  function swapBeforeOpen(swap: () => void): void {
    vi.spyOn(fs, "openSync").mockImplementationOnce((...args: Parameters<typeof fs.openSync>) => {
      swap();
      return realOpen(...args);
    });
  }

  it("refuses a symlink swapped in after the lstat", () => {
    writeCredentials(fakeCredentials());
    const target = path.join(home, "elsewhere.json");
    writeFileWithMode(target, JSON.stringify(fakeCredentials()), 0o600);
    swapBeforeOpen(() => {
      fs.rmSync(credentials);
      fs.symlinkSync(target, credentials);
    });
    const read = vi.spyOn(fs, "readSync");

    const state = readLoginState(configDir, { now: NOW, uid });

    expect(state).toEqual({ status: "refused", reason: "not-a-regular-file" });
    expect(read).not.toHaveBeenCalled();
  });

  it("refuses a different file renamed in after the lstat", () => {
    writeCredentials(fakeCredentials());
    const other = path.join(configDir, "other.json");
    writeFileWithMode(other, JSON.stringify(fakeCredentials()), 0o600);
    swapBeforeOpen(() => fs.renameSync(other, credentials));
    const read = vi.spyOn(fs, "readSync");

    const state = readLoginState(configDir, { now: NOW, uid });

    expect(state).toEqual({ status: "refused", reason: "not-a-regular-file" });
    expect(read).not.toHaveBeenCalled();
  });

  it("refuses a mode widened after the lstat", () => {
    writeCredentials(fakeCredentials());
    swapBeforeOpen(() => fs.chmodSync(credentials, 0o644));
    const read = vi.spyOn(fs, "readSync");

    const state = readLoginState(configDir, { now: NOW, uid });

    expect(state).toEqual({ status: "refused", reason: "mode-too-wide" });
    expect(read).not.toHaveBeenCalled();
  });

  it("reports missing for a file removed after the lstat", () => {
    writeCredentials(fakeCredentials());
    swapBeforeOpen(() => fs.rmSync(credentials));

    expect(readLoginState(configDir, { now: NOW, uid })).toEqual({ status: "missing" });
  });

  it("closes the descriptor it opened, refused or read", () => {
    writeCredentials(fakeCredentials(), 0o644);
    const close = vi.spyOn(fs, "closeSync");

    readLoginState(configDir, { now: NOW, uid });
    fs.chmodSync(credentials, 0o600);
    readLoginState(configDir, { now: NOW, uid });

    expect(close).toHaveBeenCalledTimes(2);
  });
});

describe("readLoginState never leaks the canary", () => {
  it("refuses malformed JSON without quoting it", () => {
    writeCredentials(`{"claudeAiOauth":{"accessToken":"${FAKE_ACCESS_TOKEN}",`);

    const state = readLoginState(configDir, { now: NOW, uid });

    expect(state).toEqual({ status: "refused", reason: "malformed" });
    expectNoCanary(state);
  });

  it("refuses an oversized file without parsing it", () => {
    const padding = " ".repeat(MAX_CREDENTIALS_BYTES);
    writeCredentials(`${JSON.stringify(fakeCredentials())}${padding}`);

    const state = readLoginState(configDir, { now: NOW, uid });

    expect(state).toEqual({ status: "refused", reason: "malformed" });
    expectNoCanary(state);
  });

  it("refuses a file that grew past the cap after the fstat", () => {
    writeCredentials(fakeCredentials());
    const realFstat = fs.fstatSync;
    vi.spyOn(fs, "fstatSync").mockImplementationOnce((fd: number) => {
      const stat = realFstat(fd);
      fs.appendFileSync(credentials, " ".repeat(MAX_CREDENTIALS_BYTES));
      return stat;
    });

    expect(readLoginState(configDir, { now: NOW, uid })).toEqual({ status: "refused", reason: "malformed" });
  });

  it("refuses a block holding no access token", () => {
    writeCredentials(fakeCredentials({ accessToken: 42 }));

    const state = readLoginState(configDir, { now: NOW, uid });

    expect(state).toEqual({ status: "refused", reason: "malformed" });
    expectNoCanary(state);
  });

  it("redacts a token-shaped path from a thrown error and drops its cause", () => {
    const blocker = path.join(home, FAKE_ACCESS_TOKEN);
    fs.writeFileSync(blocker, "");

    const error = thrown(() => readLoginState(blocker, { now: NOW, uid }));

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).cause).toBeUndefined();
    expect(errorText(error)).toContain("ENOTDIR");
    expect(errorText(error)).not.toContain(CANARY);
    expectNoCanary();
  });

  it("writes nothing to the console or standard streams", () => {
    writeCredentials(fakeCredentials());

    readLoginState(configDir, { now: NOW, uid });

    expect(output.text()).toBe("");
  });
});
