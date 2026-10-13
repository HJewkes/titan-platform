#!/usr/bin/env node
// CI's test step: on a pull request, run only the packages its diff reaches through the workspace graph; on main and
// the release PR, run everything, so main stays the authority. Not vitest --changed: packages import each other's
// dist, which no import graph from a changed src file reaches.
// Usage: node scripts/test-scope.mjs [--run]   (reads EVENT_NAME, HEAD_REF, BASE_SHA and HEAD_SHA)
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, globSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT_TESTS = "scripts/";

// Root inputs every test can depend on, and this scoping itself.
const FULL_PATHS = new Set([
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  ".node-version",
  ".npmrc",
  "vitest.config.ts",
  "tsconfig.base.json",
  "turbo.json",
  "eslint.config.js",
  "eslint.typed.config.js",
  "scripts/vitest-tmpdir.mjs",
  "scripts/test-affected.mjs",
  "scripts/test-scope.mjs",
]);
const FULL_PREFIXES = ["scripts/fixtures/", ".github/"];

// Read by no test; docs:build, lint and the changeset guard cover them.
const NO_TEST_PATHS = new Set([
  "README.md",
  "AGENTS.md",
  "CLAUDE.md",
  "CAPABILITIES.md",
  "LICENSE",
  "NOTICE",
  "eslint-suppressions.json",
  "eslint-suppressions.typed.json",
]);
const NO_TEST_PREFIXES = [".changeset/", "site/"];

// Files outside a package that a package's tests read at runtime. They come before the no-test prefixes.
const RUNTIME_COUPLINGS = [
  { prefix: "site/guides/shepherd.md", dirs: ["products/factory/"] },
  { prefix: "metrics/", dirs: ["products/factory/"] },
  { prefix: ".codewatch/", dirs: ["products/factory/", ROOT_TESTS] },
  { prefix: "scripts/areas", dirs: ["products/factory/", ROOT_TESTS] },
];

const startsWithAny = (path, prefixes) => prefixes.some((prefix) => path.startsWith(prefix));

/** What one changed path asks for: the full suite, no tests, or the test dirs it touches before the closure. */
function classifyPath(path, memberDirs) {
  if (FULL_PATHS.has(path) || startsWithAny(path, FULL_PREFIXES)) return { kind: "full" };
  const coupling = RUNTIME_COUPLINGS.find(({ prefix }) => path.startsWith(prefix));
  if (coupling) return { kind: "dirs", dirs: coupling.dirs };
  const member = memberDirs.find((dir) => path.startsWith(dir));
  if (member) return { kind: "dirs", dirs: [member] };
  if (path.startsWith(ROOT_TESTS) || path.startsWith("templates/")) return { kind: "dirs", dirs: [ROOT_TESTS] };
  if (NO_TEST_PATHS.has(path) || startsWithAny(path, NO_TEST_PREFIXES)) return { kind: "none" };
  return { kind: "full" };
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
 * take seconds.
 */
export function testScope(changedFiles, workspace) {
  if (changedFiles.length === 0) return { mode: "full", reason: "empty diff" };
  const memberDirs = workspace.map((member) => member.dir).sort((a, b) => b.length - a.length);
  const touched = new Set();
  for (const path of changedFiles) {
    const verdict = classifyPath(path, memberDirs);
    if (verdict.kind === "full") return { mode: "full", reason: path };
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

/** The scope for this CI event: full unless a pull request other than the release PR names both ends of its diff. */
export function scopeForEvent(env, readChanged, loadWorkspace) {
  if (env.EVENT_NAME !== "pull_request") return { mode: "full", reason: `event ${env.EVENT_NAME || "unknown"}` };
  if (env.HEAD_REF === "changeset-release/main") return { mode: "full", reason: "release PR" };
  if (!env.BASE_SHA || !env.HEAD_SHA) return { mode: "full", reason: "no base or head sha" };
  try {
    return testScope(readChanged(env.BASE_SHA, env.HEAD_SHA), loadWorkspace());
  } catch (err) {
    return { mode: "full", reason: `scope unreadable: ${err.message.split("\n")[0]}` };
  }
}

export function vitestArgs(scope) {
  const args = ["run", "--passWithNoTests"];
  if (scope.mode !== "scoped") return args;
  return [...args, "--project", "threads", "--project", "repo", "--project", "forks", ...scope.dirs];
}

function describeScope(scope) {
  if (scope.mode === "scoped") return `test scope: scoped to ${scope.dirs.join(" ")}`;
  if (scope.mode === "none") return "test scope: none (no changed path is read by a test)";
  return `test scope: full (${scope.reason})`;
}

function main() {
  const scope = scopeForEvent(process.env, changedFiles, readWorkspace);
  const line = describeScope(scope);
  console.log(line);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
  if (!process.argv.includes("--run") || scope.mode === "none") return;
  const vitest = join(ROOT, "node_modules", "vitest", "vitest.mjs");
  const result = spawnSync(process.execPath, [vitest, ...vitestArgs(scope)], { cwd: ROOT, stdio: "inherit" });
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
