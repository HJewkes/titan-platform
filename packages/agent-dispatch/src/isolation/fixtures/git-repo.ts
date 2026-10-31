import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gitChildEnv } from "@titan-design/worktree";
import type { IsolationContext } from "../strategy.js";

const tmpdirs: string[] = [];

/** Each test file calls this from `afterEach`. */
export function removeTempDirs(): void {
  for (const dir of tmpdirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
}

export function tempDir(prefix = "iso-"): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tmpdirs.push(dir);
  return dir;
}

export const git = (args: string[], cwd: string): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe", env: gitChildEnv() }).trim();

/** A real repository with one commit: worktree behaviour is not provable against a mock. */
export function makeRepo(): string {
  const dir = tempDir();
  git(["init", "-b", "main"], dir);
  git(["config", "user.email", "test@example.com"], dir);
  git(["config", "user.name", "Test"], dir);
  git(["config", "commit.gpgsign", "false"], dir);
  fs.writeFileSync(path.join(dir, "README.md"), "seed\n");
  git(["add", "."], dir);
  git(["commit", "-m", "seed"], dir);
  return dir;
}

export const ctxFor = (cwd: string, overrides: Partial<IsolationContext> = {}): IsolationContext => ({
  agentId: "ag-1",
  agentName: "alice",
  baseCwd: cwd,
  ...overrides,
});

export const commitIn = (dir: string, file: string): string => {
  fs.writeFileSync(path.join(dir, file), "work\n");
  git(["add", file], dir);
  git(["commit", "-m", `add ${file}`], dir);
  return git(["rev-parse", "HEAD"], dir);
};

/** Pulled from the bare side, because a session's push guard refuses a push that moves main. */
export const updateRemoteMain = (remote: string, repo: string): void => {
  git(["fetch", "--quiet", repo, "+main:main"], remote);
};

/** A bare "origin" for `repo`, holding its main. */
export function withRemote(repo: string): string {
  const remote = tempDir("iso-remote-");
  git(["init", "--bare", "-b", "main"], remote);
  git(["remote", "add", "origin", remote], repo);
  updateRemoteMain(remote, repo);
  git(["fetch", "--quiet", "origin"], repo);
  return remote;
}
