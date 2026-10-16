import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ExecAbortedError,
  ExecError,
  ExecTimeoutError,
  execSafe,
  execSafeAsync,
  minimalEnv,
  resolveBinaryPath,
} from "./exec.js";
import { installExecutable } from "./test-support.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "relay-daemon-exec-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeScript(contents: string): string {
  const path = join(dir, "script.sh");
  installExecutable(path, contents);
  return path;
}

describe("resolveBinaryPath", () => {
  it("rejects a relative path", () => {
    expect(() => resolveBinaryPath("bin/thing", "thing")).toThrow(ExecError);
  });

  it("rejects a path that does not exist", () => {
    expect(() => resolveBinaryPath(join(dir, "missing"), "thing")).toThrow(
      ExecError,
    );
  });

  it("rejects a directory, even one with the executable (traversable) bit set", () => {
    // X_OK alone would accept this — POSIX treats a traversable directory
    // as "executable" — so this guards the regular-file check.
    expect(() => resolveBinaryPath(dir, "thing")).toThrow(ExecError);
  });

  it("rejects a path that exists but is not executable", () => {
    const path = join(dir, "not-executable");
    writeFileSync(path, "not a script");
    chmodSync(path, 0o644);
    expect(() => resolveBinaryPath(path, "thing")).toThrow(ExecError);
  });

  it("accepts an absolute, executable path", () => {
    const path = writeScript("#!/bin/sh\nexit 0\n");
    expect(resolveBinaryPath(path, "thing")).toBe(path);
  });
});

describe("minimalEnv", () => {
  it("carries only PATH, HOME, and USER, never the caller's full environment", () => {
    const env = minimalEnv();
    expect(Object.keys(env).sort()).toEqual(["HOME", "PATH", "USER"]);
  });

  it("sets USER from the OS (getpwuid), not from process.env", () => {
    const env = minimalEnv();
    expect(env.USER).toBe(userInfo().username);
  });

  it("seeds PATH with this process's own interpreter directory, so a #!/usr/bin/env node script can find node in the child's PATH", () => {
    const env = minimalEnv();
    expect((env.PATH ?? "").split(":")).toContain(dirname(process.execPath));
  });
});

describe("execSafe", () => {
  it("returns stdout and a zero status on success", () => {
    const path = writeScript("#!/bin/sh\necho hello\nexit 0\n");
    const result = execSafe(path, [], minimalEnv(), 5_000);
    expect(result.stdout.trim()).toBe("hello");
    expect(result.status).toBe(0);
  });

  it("returns a non-zero status rather than throwing, for the callee to interpret", () => {
    const path = writeScript("#!/bin/sh\necho partial\nexit 3\n");
    const result = execSafe(path, [], minimalEnv(), 5_000);
    expect(result.status).toBe(3);
    expect(result.stdout.trim()).toBe("partial");
  });

  it("throws ExecError when the binary cannot be started at all", () => {
    expect(() =>
      execSafe(join(dir, "does-not-exist"), [], minimalEnv(), 5_000),
    ).toThrow(ExecError);
  });

  it("throws ExecError on timeout rather than hanging the daemon", () => {
    const path = writeScript("#!/bin/sh\nsleep 5\n");
    expect(() => execSafe(path, [], minimalEnv(), 100)).toThrow(ExecError);
  });

  /** R-90: a timed-out send may have acted, so callers must tell it from a start failure. */
  it("marks a timeout apart from a binary that could not start", () => {
    const slow = writeScript("#!/bin/sh\nsleep 5\n");
    expect(() => execSafe(slow, [], minimalEnv(), 100)).toThrow(ExecTimeoutError);
    expect(() =>
      execSafe(join(dir, "does-not-exist"), [], minimalEnv(), 5_000),
    ).not.toThrow(ExecTimeoutError);
  });

  it("never inherits the caller's process.env", () => {
    process.env.RELAY_EXEC_TEST_CANARY = "leaked";
    const path = writeScript(
      '#!/bin/sh\necho "[$RELAY_EXEC_TEST_CANARY]"\nexit 0\n',
    );
    const result = execSafe(path, [], minimalEnv(), 5_000);
    delete process.env.RELAY_EXEC_TEST_CANARY;
    expect(result.stdout.trim()).toBe("[]");
  });
});

describe("execSafeAsync", () => {
  it("delivers input on the child's stdin", async () => {
    const result = await execSafeAsync("/bin/cat", [], minimalEnv(), 5_000, "kept out of argv\n");
    expect(result).toEqual({ stdout: "kept out of argv\n", stderr: "", status: 0 });
  });

  it("closes stdin when no input is given, so a reading child does not hang", async () => {
    const result = await execSafeAsync("/bin/cat", [], minimalEnv(), 5_000);
    expect(result.stdout).toBe("");
  });

  it("resolves with the exit status when the child exits without reading a large input", async () => {
    const result = await execSafeAsync("/bin/sh", ["-c", "exit 3"], minimalEnv(), 5_000, "x".repeat(4 * 1024 * 1024));
    expect(result.status).toBe(3);
  });

  it("runs the child in cwd when one is given", async () => {
    const result = await execSafeAsync("/bin/pwd", ["-P"], minimalEnv(), 5_000, undefined, dir);
    expect(result.stdout.trim()).toBe(realpathSync(dir));
  });

  it("inherits the caller's cwd when none is given", async () => {
    const result = await execSafeAsync("/bin/pwd", ["-P"], minimalEnv(), 5_000);
    expect(result.stdout.trim()).toBe(realpathSync(process.cwd()));
  });

  it("kills a running child when the signal aborts", async () => {
    const pidFile = join(dir, "pid");
    const controller = new AbortController();
    const run = execSafeAsync("/bin/sh", ["-c", `echo $$ > ${pidFile}; exec sleep 60`], minimalEnv(), 60_000, undefined, undefined, controller.signal);
    await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "");
    const pid = Number(readFileSync(pidFile, "utf8"));

    controller.abort();

    await expect(run).rejects.toBeInstanceOf(ExecAbortedError);
    await vi.waitFor(() => expect(isAlive(pid)).toBe(false), { timeout: 2_000 });
  });

  it("starts no child once the signal has aborted", async () => {
    const marker = join(dir, "ran");

    const run = execSafeAsync("/bin/sh", ["-c", `touch ${marker}`], minimalEnv(), 5_000, undefined, undefined, AbortSignal.abort());

    await expect(run).rejects.toBeInstanceOf(ExecAbortedError);
    expect(existsSync(marker)).toBe(false);
  });
});

async function waitFor(ready: () => boolean): Promise<void> {
  while (!ready()) await new Promise((resolve) => setTimeout(resolve, 10));
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
