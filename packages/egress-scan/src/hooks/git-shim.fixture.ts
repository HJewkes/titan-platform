import { execFileSync, spawnSync, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fixtureEnv, seedRepo } from "@titan-design/test-kit/git";
import { afterAll, expect } from "vitest";
import { gitHooksEnv, writeGitHooks, type HookSetup } from "./dir.js";
import { findRealGit, writeGitShim } from "./git-shim.js";
import type { ScanInputs } from "./pre-push.js";
import { holdsAgentChatShim } from "./shim-header.js";

export const NO_VERIFY = ["--no", "verify"].join("-");

/** PATH without an agent session's own shims, so the shim under test never execs a second shim (CC-442). */
export const HOST_PATH = (process.env.PATH ?? "")
  .split(path.delimiter)
  .filter((dir) => !holdsAgentChatShim(dir))
  .join(path.delimiter);

/** The real git `findRealGit` finds on `searchPath`; a host with none fails the test here, not later. */
export function realGitOn(searchPath: string, shimDir: string): string {
  const found = findRealGit(searchPath, shimDir);
  if (found === undefined) throw new Error("no git on PATH but an agent-chat shim");
  return found;
}

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

/** A work repo with one commit and an empty bare remote, built once per file and copied into each case. */
interface RepoPair {
  work: string;
  remote: string;
}

function buildRepoPair(root: string, git: GitShimHarness["git"]): RepoPair {
  const pair = { work: path.join(root, "work"), remote: path.join(root, "remote.git") };
  const emptyTemplate = path.join(root, "empty-template");
  fs.mkdirSync(emptyTemplate, { recursive: true });
  seedRepo(pair.work);
  git(root, "init", "-q", `--template=${emptyTemplate}`, "--bare", pair.remote);
  git(pair.work, "remote", "add", "origin", pair.remote);
  git(pair.work, "remote", "add", "net", "ssh://git.invalid/remote.git");
  return pair;
}

/** Copies the pair into `root`, pointing the work repo's origin at the copied remote. */
function copyRepoPair(pair: RepoPair, root: string): RepoPair {
  const copy = { work: path.join(root, "work"), remote: path.join(root, "remote.git") };
  fs.cpSync(pair.work, copy.work, { recursive: true });
  fs.cpSync(pair.remote, copy.remote, { recursive: true });
  const config = path.join(copy.work, ".git", "config");
  fs.writeFileSync(config, fs.readFileSync(config, "utf8").replace(pair.remote, copy.remote));
  return copy;
}

/** A repo with one commit, a bare remote, a guard dir whose pre-push leaves a marker, and the shim. */
function makeFixture(root: string, pair: RepoPair, shellAliases: readonly string[]): GitShimFixture {
  const { work, remote } = copyRepoPair(pair, root);
  const guard = path.join(root, "git-hooks");
  const shimDir = path.join(root, "git-bin");
  const home = path.join(root, "home");
  const marker = path.join(root, "pre-push-ran");
  for (const dir of [guard, home]) fs.mkdirSync(dir, { recursive: true });
  installExecutable(path.join(guard, "pre-push"), `#!/bin/sh\ncat >/dev/null\ntouch '${marker}'\n`);
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

/**
 * Installs an executable at `file` without this process ever holding it open for writing. Tests run on
 * worker threads of one process, and a sibling thread's fork inherits any fd open at that moment; on
 * Linux, exec'ing a file a child still has open for write fails ETXTBSY. Letting `cp` do the write keeps
 * the fd in a process that has exited before the first exec.
 */
export function installExecutable(file: string, contents: string): void {
  const staging = `${file}.staging`;
  fs.writeFileSync(staging, contents);
  fs.chmodSync(staging, 0o755);
  execFileSync("cp", ["-p", staging, file]);
  fs.rmSync(staging);
}

/** A scratch dir removed after the file's tests, and fixtures whose only remote is a local bare repo. */
export function gitShimHarness(): GitShimHarness {
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "egress-git-shim-")));
  afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const realGit = realGitOn(HOST_PATH, path.join(scratch, "none"));
  let count = 0;

  const git = (cwd: string, ...args: string[]): string => execFileSync(realGit, args, { cwd, encoding: "utf8", env: fixtureEnv() });

  let pair: RepoPair | undefined;

  const fixture = (shellAliases: readonly string[] = []): GitShimFixture => {
    pair ??= buildRepoPair(path.join(scratch, "template"), git);
    return makeFixture(path.join(scratch, `case-${++count}`), pair, shellAliases);
  };

  /** Runs a script file, as make or an npm script would; a recursing shim is killed by the timeout. */
  function runScript(fx: GitShimFixture, body: string): ScriptRun {
    const script = path.join(fx.work, "..", `script-${++count}.sh`);
    installExecutable(script, `#!/bin/sh\n${body}\n`);
    return expectSpawned(spawnSync(script, { cwd: fx.work, env: fx.env, encoding: "utf8", timeout: 10_000 }), body);
  }

  const remoteHasMain = (fx: GitShimFixture): boolean =>
    spawnSync(realGit, ["--git-dir", fx.remote, "rev-parse", "-q", "--verify", "refs/heads/main"]).status === 0;

  return { scratch, realGit, git, fixture, runScript, remoteHasMain };
}

/**
 * `writeGitHooks` into a staging dir, then `cp` the hooks into `dir`, for a test that execs a hook it just
 * wrote: the write fd would otherwise leak into a sibling thread's fork and make the exec fail ETXTBSY.
 */
export function writeGitHooksForExec(dir: string, inputs: ScanInputs, setup: HookSetup): void {
  const staging = `${dir}.staging`;
  writeGitHooks(staging, inputs, setup);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  execFileSync("cp", ["-Rp", `${staging}/.`, dir]);
  fs.rmSync(staging, { recursive: true, force: true });
}
