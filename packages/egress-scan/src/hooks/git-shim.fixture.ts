import { execFileSync, spawnSync, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fixtureEnv, seedRepo } from "@titan-design/test-kit/git";
import { afterAll, expect } from "vitest";
import { gitHooksEnv } from "./dir.js";
import { findRealGit, writeGitShim } from "./git-shim.js";
import { holdsAgentChatShim } from "./shim-header.js";

export const NO_VERIFY = ["--no", "verify"].join("-");

/** PATH without an agent session's own shims, so the shim under test never execs a second shim (CC-442). */
export const HOST_PATH = (process.env.PATH ?? "")
  .split(path.delimiter)
  .filter((dir) => !holdsAgentChatShim(dir))
  .join(path.delimiter);

/**
 * Throws when spawnSync's child never ran or was killed (ETXTBSY, ENOENT, ETIMEDOUT, ENOBUFS),
 * naming the cause instead of leaving undefined output to fail a later assertion (CC-462).
 */
export function expectSpawned<T extends SpawnSyncReturns<string>>(result: T, command: string): T {
  if (result.error === undefined) return result;
  const stderr = result.stderr ? result.stderr : "<none>";
  throw new Error(`${command} did not complete: ${result.error.message} (status ${result.status}, signal ${result.signal})\nstderr: ${stderr}`);
}

export interface GitShimFixture {
  work: string;
  remote: string;
  guard: string;
  shimDir: string;
  marker: string;
  env: Record<string, string> & { PATH: string };
}

type ScriptRun = SpawnSyncReturns<string>;

export interface GitShimHarness {
  scratch: string;
  realGit: string;
  git: (cwd: string, ...args: string[]) => string;
  fixture: (shellAliases?: readonly string[]) => GitShimFixture;
  runScript: (fx: GitShimFixture, body: string) => ScriptRun;
  remoteHasMain: (fx: GitShimFixture) => boolean;
}

/** A repo with one commit, a bare remote, a guard dir whose pre-push leaves a marker, and the shim. */
function makeFixture(root: string, git: GitShimHarness["git"], shellAliases: readonly string[]): GitShimFixture {
  const work = path.join(root, "work");
  const remote = path.join(root, "remote.git");
  const guard = path.join(root, "git-hooks");
  const shimDir = path.join(root, "git-bin");
  const home = path.join(root, "home");
  const marker = path.join(root, "pre-push-ran");
  for (const dir of [guard, home]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(guard, "pre-push"), `#!/bin/sh\ncat >/dev/null\ntouch '${marker}'\n`, { mode: 0o755 });
  seedRepo(work);
  git(root, "init", "-q", "--bare", remote);
  git(work, "remote", "add", "origin", remote);
  git(work, "remote", "add", "net", "ssh://git.invalid/remote.git");
  expect(writeGitShim(shimDir, guard, HOST_PATH, shellAliases, { HOME: home })).toBe(true);
  const env = {
    PATH: `${shimDir}:/usr/bin:/bin`,
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_SSH_COMMAND: "false",
    GIT_TERMINAL_PROMPT: "0",
    ...gitHooksEnv(guard),
  };
  return { work, remote, guard, shimDir, marker, env };
}

/** A scratch dir removed after the file's tests, and fixtures whose only remote is a local bare repo. */
export function gitShimHarness(): GitShimHarness {
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "egress-git-shim-")));
  afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const realGit = findRealGit(HOST_PATH, path.join(scratch, "none")) as string;
  let count = 0;

  const git = (cwd: string, ...args: string[]): string => execFileSync(realGit, args, { cwd, encoding: "utf8", env: fixtureEnv() });

  const fixture = (shellAliases: readonly string[] = []): GitShimFixture => makeFixture(path.join(scratch, `case-${++count}`), git, shellAliases);

  /** Runs a script file, as make or an npm script would; a recursing shim is killed by the timeout. */
  function runScript(fx: GitShimFixture, body: string): ScriptRun {
    const script = path.join(fx.work, "..", `script-${++count}.sh`);
    fs.writeFileSync(script, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return expectSpawned(spawnSync(script, { cwd: fx.work, env: fx.env, encoding: "utf8", timeout: 10_000 }), body);
  }

  const remoteHasMain = (fx: GitShimFixture): boolean =>
    spawnSync(realGit, ["--git-dir", fx.remote, "rev-parse", "-q", "--verify", "refs/heads/main"]).status === 0;

  return { scratch, realGit, git, fixture, runScript, remoteHasMain };
}
