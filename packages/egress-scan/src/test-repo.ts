import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** A throwaway git repository for tests, committed to with the machine's git config ignored. */
export interface TestRepo {
  readonly dir: string;
  git(args: readonly string[]): string;
  write(relPath: string, contents: string): void;
  /** Stages everything, commits, and returns the new sha. */
  commit(message: string): string;
}

const ISOLATED_ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: os.devNull,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

export const ZERO_SHA = "0".repeat(40);

/** A home path assembled at runtime, so this repo's own scan never sees it as a literal. */
export function plantedHomePath(): string {
  return ["", "Users", "zq" + "planted", "src"].join("/");
}

export function tempDir(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

export function makeTestRepo(dir = tempDir("egress-scan-")): TestRepo {
  const git = (args: readonly string[]): string =>
    execFileSync("git", [...args], { cwd: dir, encoding: "utf-8", env: ISOLATED_ENV });
  git(["init", "-q", "-b", "main"]);
  return {
    dir,
    git,
    write(relPath, contents) {
      fs.mkdirSync(path.dirname(path.join(dir, relPath)), { recursive: true });
      fs.writeFileSync(path.join(dir, relPath), contents);
    },
    commit(message) {
      git(["add", "-A"]);
      git(["commit", "-q", "--allow-empty", "-m", message]);
      return git(["rev-parse", "HEAD"]).trim();
    },
  };
}
