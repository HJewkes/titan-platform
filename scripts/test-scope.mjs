#!/usr/bin/env node
// CI's test step: on a pull request, run only the packages its diff reaches through the workspace graph; on main and
// the release PR, run everything, so main stays the authority. Not vitest --changed: packages import each other's
// dist, which no import graph from a changed src file reaches.
// Usage: node scripts/test-scope.mjs [--plan] [--run [--skip-sharded] [--shard=i/n]]
//   (reads EVENT_NAME, HEAD_REF, BASE_SHA and HEAD_SHA; --plan writes placement=none|validate|shards to GITHUB_OUTPUT)
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, globSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { lockfileScope } from "./lockfile-scope.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT_TESTS = "scripts/";
const LOCKFILE = "pnpm-lock.yaml";

// Root inputs every test can depend on, and this scoping itself.
const FULL_PATHS = new Set([
  "package.json",
  "pnpm-workspace.yaml",
  ".node-version",
  ".npmrc",
  "vitest.config.ts",
  "tsconfig.base.json",
  "turbo.json",
  "eslint.config.js",
  "eslint.typed.config.js",
  "scripts/vitest-tmpdir.mjs",
  "scripts/vitest-wait-budget.mjs",
  "scripts/vitest-file-watchdog.mjs",
  "scripts/vitest-file-timing.mjs",
  "scripts/wait-budget.mjs",
  "products/factory/src/test-support/vitest-setup.ts",
  "scripts/test-affected.mjs",
  "scripts/test-scope.mjs",
  "scripts/lockfile-scope.mjs",
]);
const FULL_PREFIXES = ["scripts/fixtures/", ".github/"];

// Root files the script tests read from the live repo: structure.test.mjs holds R53 (AGENTS.md copies CLAUDE.md).
const ROOT_TEST_INPUTS = new Set(["AGENTS.md", "CLAUDE.md"]);

// Read by no test, live or by fixture; docs:build, lint and the changeset guard cover them.
const NO_TEST_PATHS = new Set(["README.md", "CAPABILITIES.md", "LICENSE", "NOTICE"]);
const NO_TEST_PREFIXES = [".changeset/", "site/"];
// A baseline changes what lint reports, not what a package's tests do, so only the script tests that guard baselines run.
const LINT_BASELINE = /(?:^|\/)eslint-suppressions(?:\.typed)?\.json$/;

// Edges the package graph cannot see, added on top of a path's own tests: files outside a package that its tests
// read, and root scripts its tests run with what they load. factory's audit/production.test.ts runs
// scripts/areas.mjs, which imports scripts/new-package.mjs and loads packages/pm/dist.
const RUNTIME_COUPLINGS = [
  { prefix: "site/guides/shepherd.md", dirs: ["products/factory/"] },
  { prefix: "metrics/", dirs: ["products/factory/", ROOT_TESTS] },
  { prefix: ".codewatch/", dirs: ["products/factory/", ROOT_TESTS] },
  { prefix: "scripts/areas", dirs: ["products/factory/"] },
  { prefix: "scripts/new-package.mjs", dirs: ["products/factory/"] },
  { prefix: "packages/pm/", dirs: ["products/factory/"] },
];

const startsWithAny = (path, prefixes) => prefixes.some((prefix) => path.startsWith(prefix));

/** The tests a path owns: its member, the root script tests, none ([]), or null for a path this does not know. */
function ownTestDirs(path, memberDirs) {
  if (LINT_BASELINE.test(path)) return [ROOT_TESTS];
  const member = memberDirs.find((dir) => path.startsWith(dir));
  if (member) return [member];
  if (ROOT_TEST_INPUTS.has(path) || path.startsWith(ROOT_TESTS) || path.startsWith("templates/")) return [ROOT_TESTS];
  if (NO_TEST_PATHS.has(path) || startsWithAny(path, NO_TEST_PREFIXES)) return [];
  return null;
}

/** What one changed path asks for: the full suite, no tests, or the test dirs it touches before the closure. */
function classifyPath(path, memberDirs) {
  if (FULL_PATHS.has(path) || startsWithAny(path, FULL_PREFIXES)) return { kind: "full" };
  const coupled = RUNTIME_COUPLINGS.filter(({ prefix }) => path.startsWith(prefix)).flatMap(({ dirs }) => dirs);
  const own = ownTestDirs(path, memberDirs);
  if (own === null && coupled.length === 0) return { kind: "full" };
  const dirs = [...coupled, ...(own ?? [])];
  return dirs.length > 0 ? { kind: "dirs", dirs } : { kind: "none" };
}

/** Each member dir mapped to the member dirs that depend on it. */
function dependentsByDir(workspace) {
  const dirByName = new Map(workspace.map((member) => [member.name, member.dir]));
  const dependents = new Map(workspace.map((member) => [member.dir, []]));
  for (const member of workspace) {
    for (const dep of member.deps) {
      if (dirByName.has(dep)) dependents.get(dirByName.get(dep)).push(member.dir);
    }
  }
  return dependents;
}

function reverseClosure(dirs, dependents) {
  const seen = new Set(dirs);
  const queue = [...dirs];
  while (queue.length > 0) {
    for (const next of dependents.get(queue.pop()) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}

/**
 * The tests a diff needs. Root script tests join every scoped run: several read the live workspace layout, and they
 * take seconds. `readLock` returns the lockfile text at the merge base and the head, read only when the diff has it.
 */
export function testScope(changedFiles, workspace, readLock = () => null) {
  if (changedFiles.length === 0) return { mode: "full", reason: "empty diff" };
  const memberDirs = workspace.map((member) => member.dir).sort((a, b) => b.length - a.length);
  const touched = new Set();
  for (const path of changedFiles) {
    const verdict = path === LOCKFILE ? lockfileScope(readLock(), memberDirs) : classifyPath(path, memberDirs);
    if (verdict.kind === "full") return { mode: "full", reason: verdict.reason ?? path };
    if (verdict.kind === "dirs") verdict.dirs.forEach((dir) => touched.add(dir));
  }
  if (touched.size === 0) return { mode: "none" };
  const closure = reverseClosure([...touched], dependentsByDir(workspace));
  return { mode: "scoped", dirs: [...closure.add(ROOT_TESTS)].sort() };
}

const WORKSPACE_DEP_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

/** Every workspace member with its dir and the names it depends on, as pnpm-workspace.yaml declares them. */
export function readWorkspace(root = ROOT) {
  const { packages } = parse(readFileSync(join(root, "pnpm-workspace.yaml"), "utf8"));
  const manifests = packages.flatMap((pattern) => globSync(`${pattern}/package.json`, { cwd: root }));
  return manifests.map((manifest) => {
    const json = JSON.parse(readFileSync(join(root, manifest), "utf8"));
    const deps = WORKSPACE_DEP_FIELDS.flatMap((field) => Object.keys(json[field] ?? {}));
    return { dir: `${dirname(manifest)}/`, name: json.name, deps };
  });
}

/** The pull request's own changes; --no-renames keeps both sides of a move between packages. */
function changedFiles(base, head, cwd = ROOT) {
  const out = execFileSync("git", ["diff", "--no-renames", "--name-only", `${base}...${head}`], { cwd, encoding: "utf8" });
  return out.split("\n").filter(Boolean);
}

/** pnpm-lock.yaml on both sides of that diff; maxBuffer because the lockfile nears execFileSync's 1 MiB default. */
function lockSides(base, head, cwd = ROOT) {
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const mergeBase = git("merge-base", base, head).trim();
  return { base: git("show", `${mergeBase}:${LOCKFILE}`), head: git("show", `${head}:${LOCKFILE}`) };
}

/** The scope for this CI event: full unless a pull request other than the release PR names both ends of its diff. */
export function scopeForEvent(env, readChanged, loadWorkspace, readLock = lockSides) {
  if (env.EVENT_NAME !== "pull_request") return { mode: "full", reason: `event ${env.EVENT_NAME || "unknown"}` };
  if (env.HEAD_REF === "changeset-release/main") return { mode: "full", reason: "release PR" };
  if (!env.BASE_SHA || !env.HEAD_SHA) return { mode: "full", reason: "no base or head sha" };
  try {
    const sides = () => readLock(env.BASE_SHA, env.HEAD_SHA);
    return testScope(readChanged(env.BASE_SHA, env.HEAD_SHA), loadWorkspace(), sides);
  } catch (err) {
    return { mode: "full", reason: `scope unreadable: ${err.message.split("\n")[0]}` };
  }
}

// On CI a hang must fail and name its file (TP-4287). hanging-process lists the handles that keep vitest from exiting
// after its last file; the watchdog names a file whose worker never yields. Locally they are noise, as is the per-file
// timing artifact (TP-4436).
export const CI_REPORTERS = ["default", "hanging-process", "./scripts/vitest-file-watchdog.mjs", "./scripts/vitest-file-timing.mjs"];

export function vitestArgs(scope, env = {}) {
  const reporters = env.CI ? CI_REPORTERS.map((reporter) => `--reporter=${reporter}`) : [];
  const args = ["run", "--passWithNoTests", ...reporters];
  if (scope.mode !== "scoped") return args;
  const projects = ["threads", "factory", "explainer", "console", "isolated", "repo", "forks", "perf", "active-work", "active-work-forks"];
  return [...args, ...projects.flatMap((project) => ["--project", project]), ...scope.dirs];
}

// A scope with more test files than this runs across CI's test-shard matrix instead of in validate's single job
// (TP-4730). Over 30 pull request runs, scopes of about 750 files took 125-185 s, about 1800 took 480-680 s and the
// full 2900 took 750-1245 s, against a 600 s budget for the whole validate job.
export const SHARD_ABOVE_FILES = 1000;

/** Where CI runs a scope: nowhere, in validate's single job, or across the test-shard matrix. */
export function placement(scope, countFiles) {
  if (scope.mode === "none") return "none";
  if (scope.mode === "full") return "shards";
  return countFiles(scope.dirs) > SHARD_ABOVE_FILES ? "shards" : "validate";
}

/** Test files under the dirs, by the suffixes vitest's projects include: an estimate that only places the run. */
export function countTestFiles(dirs, root = ROOT) {
  const patterns = dirs.map((dir) => `${dir}**/*.test.{ts,tsx,mjs}`);
  return globSync(patterns, { cwd: root, exclude: (path) => path.endsWith("node_modules") }).length;
}

/** Vitest's arguments for this invocation, or null when it runs nothing: no --run, no tests, or a run placed elsewhere. */
export function runRequest(scope, where, argv, env = {}) {
  if (!argv.includes("--run") || where === "none") return null;
  if (argv.includes("--skip-sharded") && where === "shards") return null;
  const shard = argv.find((arg) => arg.startsWith("--shard="));
  return shard ? [...vitestArgs(scope, env), shard] : vitestArgs(scope, env);
}

function describeScope(scope) {
  if (scope.mode === "scoped") return `test scope: scoped to ${scope.dirs.join(" ")}`;
  if (scope.mode === "none") return "test scope: none (no changed path is read by a test)";
  return `test scope: full (${scope.reason})`;
}

function report(scope, where) {
  const line = `${describeScope(scope)}; runs in ${where === "shards" ? "the test-shard matrix" : where}`;
  console.log(line);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
  if (process.argv.includes("--plan") && process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `placement=${where}\n`);
}

function main() {
  const scope = scopeForEvent(process.env, changedFiles, readWorkspace);
  const where = placement(scope, countTestFiles);
  report(scope, where);
  const args = runRequest(scope, where, process.argv, process.env);
  if (args === null) return;
  const vitest = join(ROOT, "node_modules", "vitest", "vitest.mjs");
  const result = spawnSync(process.execPath, [vitest, ...args], { cwd: ROOT, stdio: "inherit" });
  process.exitCode = result.status ?? 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exitCode = 1;
  }
}
