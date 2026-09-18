import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

/** A throwaway git repository for tests, isolated from the machine's git config. */
export interface TestRepo {
  dir: string;
  git(args: readonly string[]): string;
  write(relPath: string, contents: string): Promise<void>;
  /** Stage everything and commit as `author` (<author>@example.com) at an ISO `date`. */
  commit(message: string, options?: { author?: string; date?: string }): void;
  cleanup(): Promise<void>;
}

const FIXED_DATE = "2024-01-01T12:00:00Z";

/** An ISO timestamp `days` before the real clock, for windows that git resolves against real time. */
export function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86400 * 1000).toISOString();
}

export function isolatedGitEnv(date = FIXED_DATE): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
  };
}

export async function makeTestRepo(): Promise<TestRepo> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "code-graph-history-")));
  const git = (args: readonly string[], date?: string): string =>
    execFileSync("git", [...args], { cwd: dir, encoding: "utf-8", env: isolatedGitEnv(date) });
  git(["init", "-q", "-b", "main"]);
  git(["config", "commit.gpgsign", "false"]);
  return {
    dir,
    git: (args) => git(args),
    write: async (relPath, contents) => {
      const abs = path.join(dir, relPath);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, contents);
    },
    commit: (message, options = {}) => {
      const author = options.author ?? "alice";
      git(["add", "-A"]);
      const identity = ["-c", `user.name=${author}`, "-c", `user.email=${author}@example.com`];
      git([...identity, "commit", "-q", "-m", message], options.date);
    },
    cleanup: () => fs.rm(dir, { recursive: true, force: true }),
  };
}
