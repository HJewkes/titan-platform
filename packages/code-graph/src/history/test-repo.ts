import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fixtureEnv, seedRepo, withHistory, type HistoryCommit } from "@titan-design/test-kit/git";

/** A throwaway git repository for tests, copied from test-kit's template and isolated from the machine's git config. */
export interface TestRepo {
  dir: string;
  git(args: readonly string[]): string;
  write(relPath: string, contents: string): Promise<void>;
  /** Stage everything and commit as `author` (<author>@example.com) at an ISO `date`. */
  commit(message: string, options?: { author?: string; date?: string }): void;
  /** Write `commits` with one fast-import and check out the last; each defaults to `commit`'s author and date. */
  history(commits: readonly HistoryCommit[]): string[];
  cleanup(): Promise<void>;
}

const FIXED_DATE = "2024-01-01T12:00:00Z";
const DEFAULT_AUTHOR = "alice";

/** An ISO timestamp `days` before the real clock, for windows that git resolves against real time. */
export function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86400 * 1000).toISOString();
}

/** `fixtureEnv` with every commit made as `author` at `date`. */
function commitEnv(date = FIXED_DATE, author = DEFAULT_AUTHOR): NodeJS.ProcessEnv {
  const email = `${author}@example.com`;
  return {
    ...fixtureEnv(),
    GIT_AUTHOR_NAME: author,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: author,
    GIT_COMMITTER_EMAIL: email,
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
  };
}

/** A fresh empty directory, realpathed so it matches the paths git reports. */
export async function tempRepoDir(prefix = "code-graph-history-"): Promise<string> {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
}

export async function makeTestRepo(dir?: string): Promise<TestRepo> {
  const root = dir ?? (await tempRepoDir());
  seedRepo(root, {});
  return testRepoAt(root);
}

/** A `TestRepo` over the repository already at `root`, such as a copy of another test's repo. */
export function testRepoAt(root: string): TestRepo {
  const git = (args: readonly string[], env = commitEnv()): string => execFileSync("git", [...args], { cwd: root, encoding: "utf-8", env });
  return {
    dir: root,
    git: (args) => git(args),
    write: async (relPath, contents) => {
      const abs = path.join(root, relPath);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, contents);
    },
    commit: (message, options = {}) => {
      git(["add", "-A"]);
      git(["commit", "-q", "-m", message], commitEnv(options.date, options.author));
    },
    history: (commits) => withHistory(root, commits.map((c) => ({ author: DEFAULT_AUTHOR, date: FIXED_DATE, ...c }))),
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
}
