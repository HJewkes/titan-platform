import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ATTESTATIONS_DIR, LOCK_PATH, runCheck } from "./step-closure-check.mjs";

const PARENT_PR = 7;
const CHILD_PR = 8;
const UNRELATED_PR = 9;
const parentFile = `${ATTESTATIONS_DIR}/${PARENT_PR}.json`;
const rowOf = (pr) => [{ step: "ci-wait", closure: `ci-wait-${pr}`, pr }];

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Main, a parent PR that adds its row, and a child PR stacked on it; the repo is its own origin, holding refs/pull/7/head. */
function stackedRepo() {
  const root = mkdtempSync(join(tmpdir(), "closure-stack-"));
  roots.push(root);
  const git = (args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const commit = (path, value, message) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), `${JSON.stringify(value, null, 2)}\n`);
    git(["add", "-A"]);
    git(["commit", "-q", "-m", message]);
  };
  git(["init", "-q", "-b", "main"]);
  git(["remote", "add", "origin", root]);
  commit(LOCK_PATH, {}, "base");
  git(["checkout", "-q", "-b", "parent"]);
  commit(parentFile, rowOf(PARENT_PR), "parent attests");
  git(["update-ref", `refs/pull/${PARENT_PR}/head`, "parent"]);
  git(["checkout", "-q", "-b", "child"]);
  commit(`${ATTESTATIONS_DIR}/${CHILD_PR}.json`, rowOf(CHILD_PR), "child attests");
  return { root, git, commit };
}

function checkChild({ root, git }) {
  const listDir = (dir) => (existsSync(join(root, dir)) ? readdirSync(join(root, dir)) : []);
  const readFile = (path) => readFileSync(join(root, path), "utf8");
  const check = () => ({ failures: [], notices: [] });
  return runCheck({ git, readFile, listDir, check, base: "main", prNumber: CHILD_PR });
}

it("a child stacked on an open parent keeps the parent's row and passes", () => {
  const repo = stackedRepo();

  const result = checkChild(repo);

  expect(result.failures).toEqual([]);
  expect(result.notices).toContain(`rows of #${PARENT_PR} accepted: this branch is stacked on it`);
});

it("a row for a PR the branch is not stacked on still fails", () => {
  const repo = stackedRepo();
  repo.commit(`${ATTESTATIONS_DIR}/${UNRELATED_PR}.json`, rowOf(UNRELATED_PR), "row for an unrelated PR");

  const result = checkChild(repo);

  expect(result.failures).toEqual([`ci-wait@ci-wait-${UNRELATED_PR}: an added attestation row names PR ${UNRELATED_PR}, not this PR #${CHILD_PR}`]);
});

it("a row the child itself writes into the parent's file fails", () => {
  const repo = stackedRepo();
  repo.commit(parentFile, [...rowOf(PARENT_PR), { step: "merge", closure: "merge-7", pr: PARENT_PR }], "child edits the parent's file");

  const result = checkChild(repo);

  expect(result.failures).toEqual([
    `ci-wait@ci-wait-${PARENT_PR}: an added attestation row names PR ${PARENT_PR}, not this PR #${CHILD_PR}`,
    `merge@merge-${PARENT_PR}: an added attestation row names PR ${PARENT_PR}, not this PR #${CHILD_PR}`,
  ]);
});

it("after the parent squash-lands on main, the child's merge of main keeps the parent's file and passes", () => {
  const repo = stackedRepo();
  repo.git(["checkout", "-q", "main"]);
  repo.git(["merge", "-q", "--squash", "parent"]);
  repo.git(["commit", "-q", "-m", `parent (#${PARENT_PR})`]);
  repo.git(["update-ref", "-d", `refs/pull/${PARENT_PR}/head`]);
  repo.git(["checkout", "-q", "child"]);

  repo.git(["merge", "-q", "--no-edit", "main"]);

  expect(JSON.parse(readFileSync(join(repo.root, parentFile), "utf8"))).toEqual(rowOf(PARENT_PR));
  expect(checkChild(repo).failures).toEqual([]);
});
