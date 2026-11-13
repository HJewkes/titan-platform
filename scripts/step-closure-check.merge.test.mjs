import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { LOCK_PATH, resolveBase, runCheck } from "./step-closure-check.mjs";

/** Git that ignores the machine's global and system config and runs no hooks. */
const ISOLATION = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "core.hooksPath",
  GIT_CONFIG_VALUE_0: "/dev/null",
};
const lock = (closure) => ({ "ci-wait": { closure, schemaHash: "schema-1", bump: 0 } });
const PR_ENV = { GITHUB_EVENT_NAME: "pull_request", GITHUB_BASE_REF: "main" };

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** The lock `closure-old` on main; a PR branch is merged into main, then main moves on to `closure-new`. */
function movedMainRepo({ prLock }) {
  const root = mkdtempSync(join(tmpdir(), "closure-merge-"));
  roots.push(root);
  const git = (args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...ISOLATION } });
  const commit = (path, text, message) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
    git(["add", "-A"]);
    git(["commit", "-q", "-m", message]);
  };
  const write = (value) => `${JSON.stringify(value)}\n`;
  git(["init", "-q", "-b", "main"]);
  commit(LOCK_PATH, write(lock("closure-old")), "base");
  git(["checkout", "-q", "-b", "pr"]);
  commit("other.txt", "pr work\n", "pr");
  if (prLock) commit(LOCK_PATH, write(prLock), "pr moves the closure");
  git(["checkout", "-q", "main"]);
  git(["merge", "-q", "--no-ff", "-m", "merge ref", "pr"]);
  git(["branch", "merge-ref"]);
  git(["checkout", "-q", "-B", "origin/main", "merge-ref~1"]);
  commit(LOCK_PATH, write(lock("closure-new")), "main moves after the merge ref was built");
  git(["checkout", "-q", "--detach", "merge-ref"]);
  return git;
}

/** A check that fails when the tree's closure differs from the base's without a matching attestation. */
const check = ({ base, committed }) => ({ failures: base["ci-wait"].closure === committed["ci-wait"].closure ? [] : [`ci-wait: its import closure changed`], notices: [] });

function run(git, root) {
  const readFile = (path) => readFileSync(join(root, path), "utf8");
  const base = resolveBase([], PR_ENV, git);
  return { base, ...runCheck({ git, readFile, listDir: () => [], check, base, prNumber: 5 }) };
}

it("closure check compares a pull request merge commit against its first parent", () => {
  const untouched = movedMainRepo({});
  const root1 = untouched(["rev-parse", "--show-toplevel"]).trim();
  const clean = run(untouched, root1);

  const changed = movedMainRepo({ prLock: lock("closure-pr") });
  const root2 = changed(["rev-parse", "--show-toplevel"]).trim();
  const dirty = run(changed, root2);

  expect(clean.base).toBe("HEAD^1");
  expect(clean.failures).toEqual([]);
  expect(dirty.failures).toEqual(["ci-wait: its import closure changed"]);
});

it("an explicit base still wins over the merge commit's first parent", () => {
  const git = movedMainRepo({});

  expect(resolveBase([], { ...PR_ENV, CLOSURE_BASE: "origin/main" }, git)).toBe("origin/main");
  expect(resolveBase(["x"], PR_ENV, git)).toBe("x");
});

it("a head that is not a merge commit, or a run that is not a pull request, keeps the branch base", () => {
  const git = movedMainRepo({});

  expect(resolveBase([], { GITHUB_BASE_REF: "main" }, git)).toBe("origin/main");
  git(["checkout", "-q", "--detach", "pr"]);
  expect(resolveBase([], PR_ENV, git)).toBe("origin/main");
});
