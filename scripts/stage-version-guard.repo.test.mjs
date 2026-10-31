import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { BUMPS_DIR, STAGE_SPEC_PATH } from "./stage-version-guard.mjs";

const SCRIPT = path.resolve(import.meta.dirname, "stage-version-guard.mjs");
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

const writeSpec = (script) => writeFileSync(path.join(repo, STAGE_SPEC_PATH), `const BASE_STAGE_VERSIONS: Record<CachedStage, string> = {\n  script: "${script}",\n};\n`);
const writeBump = (id, stages) => writeFileSync(path.join(repo, BUMPS_DIR, `${id}.json`), JSON.stringify({ stages, why: "synthetic" }));

function commitAll(message) {
  git("add", "-A");
  git("commit", "-q", "-m", message);
}

function runGuard() {
  const env = { ...GIT_ENV, BASE_REF: "main", HEAD_SHA: "pr" };
  delete env.GITHUB_STEP_SUMMARY;
  return spawnSync(process.execPath, [SCRIPT], { cwd: repo, env, encoding: "utf8" });
}

/** main with one merged bump on script, and a PR branch cut from it. */
beforeEach(() => {
  repo = mkdtempSync(path.join(tmpdir(), "stage-version-guard-"));
  mkdirSync(path.join(repo, path.dirname(STAGE_SPEC_PATH)), { recursive: true });
  mkdirSync(path.join(repo, BUMPS_DIR), { recursive: true });
  writeSpec("x41");
  writeBump("TP-1", ["script"]);
  git("init", "-q", "-b", "main");
  commitAll("init");
  git("switch", "-q", "-c", "pr");
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

it("passes two PRs that each add a bump to the same stage, merged in turn", () => {
  writeBump("TP-2", ["script"]);
  commitAll("pr bump");
  git("switch", "-q", "main");
  writeBump("TP-3", ["script"]);
  commitAll("parallel bump");
  git("switch", "-q", "pr");
  git("merge", "-q", "--no-edit", "main");

  const result = runGuard();

  expect(result.status).toBe(0);
  expect(result.stdout).toContain("1 new bump");
});

it("passes a branch cut before a new bump landed on the base", () => {
  writeBump("TP-2", ["script"]);
  commitAll("pr bump");
  git("switch", "-q", "main");
  writeBump("TP-3", ["script"]);
  commitAll("bump landed after the branch was cut");

  const result = runGuard();

  expect(result.status).toBe(0);
  expect(result.stdout).toContain("1 new bump");
});

it("passes a PR that changes no bump", () => {
  writeFileSync(path.join(repo, "unrelated.txt"), "x");
  commitAll("unrelated");

  const result = runGuard();

  expect(result.status).toBe(0);
  expect(result.stdout).toContain("0 new bumps");
});

it("fails a PR that deletes a merged bump", () => {
  rmSync(path.join(repo, BUMPS_DIR, "TP-1.json"));
  commitAll("drop bump");

  const result = runGuard();

  expect(result.status).toBe(1);
  expect(result.stderr).toContain("bump TP-1 is on the base branch but gone");
});

it("fails a PR that lowers a base value by hand", () => {
  writeSpec("x40");
  commitAll("hand bump");

  const result = runGuard();

  expect(result.status).toBe(1);
  expect(result.stderr).toContain("base version of script changed from x41 to x40");
});
