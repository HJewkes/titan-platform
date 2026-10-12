import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { INDEXER_PATH } from "./index-version-guard.mjs";

const SCRIPT = path.resolve(import.meta.dirname, "index-version-guard.mjs");
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

let repo;

const git = (...args) => execFileSync("git", args, { cwd: repo, env: GIT_ENV, stdio: "pipe", encoding: "utf8" });

// The branch name in the message keeps two identical bumps from hashing to one commit.
function commitIndexVersion(version) {
  writeFileSync(path.join(repo, INDEXER_PATH), `// cache key\nexport const INDEX_VERSION = "${version}";\n`);
  git("commit", "-q", "-am", `INDEX_VERSION ${version} on ${git("branch", "--show-current").trim()}`);
}

function commitOther(name) {
  writeFileSync(path.join(repo, name), `${name}\n`);
  git("add", name);
  git("commit", "-q", "-m", name);
}

function runGuard() {
  const env = { ...GIT_ENV, BASE_REF: "main", HEAD_SHA: "pr" };
  delete env.GITHUB_STEP_SUMMARY;
  return spawnSync(process.execPath, [SCRIPT], { cwd: repo, env, encoding: "utf8" });
}

/** main at 0.27.0 with a PR branch cut from it, the state both TP-2474 slices started from. */
beforeEach(() => {
  repo = mkdtempSync(path.join(tmpdir(), "index-version-guard-"));
  mkdirSync(path.join(repo, path.dirname(INDEXER_PATH)), { recursive: true });
  writeFileSync(path.join(repo, INDEXER_PATH), 'export const INDEX_VERSION = "0.27.0";\n');
  git("init", "-q", "-b", "main");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  git("branch", "pr");
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

function bumpBothThenUpdateBranch() {
  git("switch", "-q", "pr");
  commitIndexVersion("0.28.0");
  git("switch", "-q", "main");
  commitIndexVersion("0.28.0");
  git("switch", "-q", "pr");
  git("merge", "-q", "--no-edit", "main");
}

it("fails an identical bump that merged cleanly onto a base that already moved (tp#1248)", () => {
  bumpBothThenUpdateBranch();

  const result = runGuard();

  expect(git("diff", "--stat", "main", "pr")).toBe("");
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("INDEX_VERSION 0.28.0 is not above base 0.28.0");
});

// A merge with main as its first parent is TREESAME to it on indexer.ts, so default history simplification would
// follow only main and drop the PR's own bump commit.
it("fails the identical bump when the update merge has main as its first parent", () => {
  git("switch", "-q", "pr");
  commitIndexVersion("0.28.0");
  git("switch", "-q", "main");
  commitIndexVersion("0.28.0");
  git("switch", "-q", "-c", "update");
  git("merge", "-q", "--no-edit", "pr");
  git("branch", "-f", "pr", "update");

  expect(runGuard().status).toBe(1);
});

it("passes once the updated branch takes the next minor", () => {
  bumpBothThenUpdateBranch();
  commitIndexVersion("0.29.0");

  const result = runGuard();

  expect(result.status).toBe(0);
  expect(result.stdout).toContain("INDEX_VERSION 0.29.0 is above base 0.28.0");
});

it("passes a PR that never touches indexer.ts while main bumps", () => {
  git("switch", "-q", "pr");
  commitOther("feature.txt");
  git("switch", "-q", "main");
  commitIndexVersion("0.28.0");
  git("switch", "-q", "pr");
  git("merge", "-q", "--no-edit", "main");

  const result = runGuard();

  expect(result.status).toBe(0);
  expect(result.stdout).toContain("untouched");
});
