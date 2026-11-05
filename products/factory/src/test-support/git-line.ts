import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const gitIn =
  (dir: string) =>
  (...args: string[]): string =>
    execFileSync("git", ["-C", dir, "-c", "user.name=test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();

const commitIn = (git: ReturnType<typeof gitIn>) => (message: string): string => (git("commit", "--quiet", "--allow-empty", "-m", message), git("rev-parse", "HEAD"));

/** A throwaway repo holding two commits, the newer a child of the older, so ancestry runs against real git with no real shas. */
export function gitLine(): { dir: string; older: string; newer: string } {
  const dir = mkdtempSync(join(tmpdir(), "factory-ancestry-"));
  const git = gitIn(dir);
  git("init", "--quiet");
  const commit = commitIn(git);
  const older = commit("older");
  return { dir, older, newer: commit("newer") };
}

/** A deploy checkout cloned before two merges landed on its origin's main, so neither merge's objects are in it. */
export function gitBehindMain(): { dir: string; checkout: string; older: string; newer: string } {
  const dir = mkdtempSync(join(tmpdir(), "factory-behind-"));
  const origin = join(dir, "origin");
  const checkout = join(dir, "checkout");
  const git = gitIn(dir);
  git("init", "--quiet", "--initial-branch=main", origin);
  const commit = commitIn(gitIn(origin));
  commit("deployed");
  git("clone", "--quiet", origin, checkout);
  const older = commit("older merge");
  return { dir, checkout, older, newer: commit("newer merge") };
}
