/**
 * The one place the daemon shells out to another program — shared by P3's
 * `initiative.ts` today and step 6d's `spawn.ts` later, so the discipline
 * sources/agent-runner-plan.md's P3 section demands is stated once, not
 * duplicated: absolute binary paths only (never resolved via `PATH`, which
 * launchd does not populate the way a login shell does), and an explicit
 * minimal environment (never `...process.env` — T7/M8 forbid it).
 */

import { execFile, execFileSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, isAbsolute } from "node:path";

export class ExecError extends Error {}
/** The child ran past its budget, so whatever it was doing may have happened. */
export class ExecTimeoutError extends ExecError {}

/**
 * Meant to be called once, wherever a caller owns config loading (config.ts
 * for daemon-wide binaries; today, once per `resolveInitiative` call, since
 * that resolution isn't yet wired through config.ts) — so a binary path
 * that is relative, missing, a directory, or not executable throws
 * immediately rather than becoming a `spawn ENOENT`/`EISDIR` (or worse, a
 * same-named program found on whatever `PATH` happens to be) the first time
 * an item needs it. `X_OK` alone accepts directories (POSIX: a directory is
 * "executable" meaning traversable), so a regular-file check comes first.
 */
export function resolveBinaryPath(path: string, purpose: string): string {
  if (!isAbsolute(path)) {
    throw new ExecError(
      `${purpose} binary path must be absolute, got '${path}'`,
    );
  }
  try {
    if (!statSync(path).isFile()) {
      throw new ExecError(`${purpose} binary is not a regular file: ${path}`);
    }
    accessSync(path, constants.X_OK);
  } catch (err) {
    if (err instanceof ExecError) throw err;
    throw new ExecError(
      `${purpose} binary not found or not executable: ${path}`,
    );
  }
  return path;
}

/**
 * The explicit, minimal environment every subprocess call site starts from.
 *
 * `PATH` is seeded with `dirname(process.execPath)` ahead of the bare-bones
 * `/usr/bin:/bin` — not because a callee is ever found by searching `PATH`
 * (every call site here already resolves an absolute binary path first,
 * per this file's own header comment), but because a `#!/usr/bin/env node`
 * shebang script (`active-work`, resolved via `ACTIVE_WORK_BIN_PATH`) still
 * needs `env` to find *its own interpreter* in the CHILD's `PATH` once
 * launched. `/usr/bin:/bin` alone does not contain node on a Homebrew or
 * nvm install, which surfaced as a real `env: node: No such file or
 * directory` failure the first time this ran for real outside test fakes
 * (fakes are plain `#!/bin/sh` scripts, which never hit this). Using this
 * process's own interpreter directory rather than a hardcoded path keeps
 * the fix portable across machines instead of encoding one operator's
 * install location.
 *
 * `USER` is set for the same class of reason, discovered the same way (a
 * real spawn against production, not a fake in a test): the `claude` binary
 * itself authenticates via a macOS Keychain-stored credential, and that
 * lookup came back "Not logged in" under `PATH`+`HOME` alone but succeeded
 * the moment `USER` was present — some part of the Keychain resolution
 * path needs it to identify whose login keychain to open, independent of
 * `HOME` already pointing at the right home directory. Read via
 * `userInfo().username` (an OS-level syscall, `getpwuid`) rather than
 * `process.env.USER` — this file's own header comment forbids widening
 * from the caller's environment, and this keeps that true even for a
 * value that happens to usually match `$USER`.
 */
export function minimalEnv(): Record<string, string> {
  return {
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: homedir(),
    USER: userInfo().username,
  };
}

export interface SafeExecResult {
  stdout: string;
  /**
   * Captured rather than inherited, because the two programs relay shells out to
   * split their failures across both streams: agent-chat prints a broker refusal
   * on stdout but a usage error — an unknown flag, a bad argument — through
   * `fail()` on stderr. A caller reading only stdout turns the entire second
   * category into a bare "exited 1" with the reason nowhere it can report it.
   */
  stderr: string;
  status: number;
}

/**
 * Runs `bin` with `args` and `env`, no shell involved at any point. Does not
 * throw on a non-zero exit — that is the callee's business to interpret
 * (P4: some non-zero exits are a refusal, not a crash) — but does throw
 * `ExecError` if the process could not be started at all, or timed out.
 *
 * `cwd` is optional because only one call site needs it and it must not be
 * settable by accident: `dispatch.ts` runs the `agent-chat` CLI, which sends
 * its OWN `process.cwd()` to the broker as the spawn location, so the child's
 * working directory is the only channel relay has for saying where the agent
 * should run. Everywhere else, inheriting this process's cwd is correct and
 * passing one would just be an unreviewed way to widen where a subprocess
 * reads from.
 *
 * `input` is stdin for the child, and exists for exactly one reason: argv is
 * world-readable via `ps`, so anything relay did not author itself — an item
 * body captured by voice — must not travel that way (R-68). It is the same
 * one-call-site rule as `cwd`; a caller with nothing to hide passes nothing.
 */
export function execSafe(
  bin: string,
  args: string[],
  env: Record<string, string>,
  timeoutMs: number,
  cwd?: string,
  input?: string,
): SafeExecResult {
  try {
    const stdout = execFileSync(bin, args, {
      env,
      timeout: timeoutMs,
      encoding: "utf8",
      shell: false,
      // Explicit, because the default sends the child's stderr straight to ours.
      // That put a usage error in the daemon's launchd log and nowhere the code
      // could reach it, which is how an unknown-flag failure reached the operator
      // as an unexplained "exited 1".
      stdio: ["pipe", "pipe", "pipe"],
      ...(cwd === undefined ? {} : { cwd }),
      ...(input === undefined ? {} : { input }),
    });
    return { stdout, stderr: "", status: 0 };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & {
      status?: number | null;
      stdout?: string;
      stderr?: string;
      signal?: string | null;
    };
    if (e.signal === "SIGTERM" || e.code === "ETIMEDOUT") {
      throw new ExecTimeoutError(`${bin} timed out after ${timeoutMs}ms`);
    }
    if (typeof e.status === "number") {
      return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", status: e.status };
    }
    throw new ExecError(`${bin} could not be started: ${e.message}`);
  }
}

/**
 * `execSafe` without blocking the event loop: same timeout, no-shell and
 * error mapping, for callers (a long-lived server) that cannot afford to
 * stall while a slow child answers.
 */
export function execSafeAsync(
  bin: string,
  args: string[],
  env: Record<string, string>,
  timeoutMs: number,
): Promise<SafeExecResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      bin,
      args,
      { env, timeout: timeoutMs, encoding: "utf8", shell: false, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err === null) return resolve({ stdout, stderr, status: 0 });
        const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null };
        if (e.killed === true || e.signal === "SIGTERM" || e.code === "ETIMEDOUT") {
          return reject(new ExecTimeoutError(`${bin} timed out after ${timeoutMs}ms`));
        }
        if (typeof e.code === "number") return resolve({ stdout, stderr, status: e.code });
        reject(new ExecError(`${bin} could not be started: ${e.message}`));
      },
    );
    // execFileSync closes the child's stdin; a child that reads it would otherwise wait forever.
    child.stdin?.end();
  });
}
