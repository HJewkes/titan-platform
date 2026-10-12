import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A throwaway repo holding two commits, the newer a child of the older, so ancestry runs against real git with no real shas. */
export function gitLine(): { dir: string; older: string; newer: string } {
  const dir = mkdtempSync(join(tmpdir(), "factory-ancestry-"));
  const git = (...args: string[]): string =>
    execFileSync("git", ["-C", dir, "-c", "user.name=test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();
  git("init", "--quiet");
  const commit = (message: string): string => (git("commit", "--quiet", "--allow-empty", "-m", message), git("rev-parse", "HEAD"));
  const older = commit("older");
  return { dir, older, newer: commit("newer") };
}
