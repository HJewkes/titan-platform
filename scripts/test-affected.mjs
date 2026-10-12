#!/usr/bin/env node
// Runs only the tests a change reaches: vitest --changed against a base. CI's full `pnpm test` stays the authority,
// because the import graph misses tests that read files at runtime.
// Usage: node scripts/test-affected.mjs [base]   (base: TEST_AFFECTED_BASE, then argv, then origin/main)
import { execFileSync, spawnSync } from "node:child_process";
import { globSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_BASE = "origin/main";

// Vitest matches these against absolute paths; a hit runs every file in the selected projects. Setting the option
// replaces vitest's defaults, so the first two restate them.
export const FORCE_RERUN_TRIGGERS = [
  "**/package.json/**",
  "**/{vitest,vite}.config.*/**",
  "**/package.json",
  "**/pnpm-lock.yaml",
  "**/vitest.config.*",
  "**/tsconfig*.json",
  "**/scripts/fixtures/**",
];

// The git-heavy files the TP-1685 kalloc sweep ranked highest; test:affected runs them only when their package changed.
export const REPO_TIER_INCLUDE = [
  "packages/*/src/**/*.repo.test.ts",
  "products/*/src/**/*.repo.test.ts",
  "scripts/**/*.repo.test.mjs",
];

export function resolveBase(env, argv) {
  return env.TEST_AFFECTED_BASE || argv[0] || DEFAULT_BASE;
}

/** The package directory a repo-relative path belongs to, or null for a path outside every package. */
export function packageDirOf(path) {
  const pkg = /^(?:packages|products|apps)\/[^/]+\//.exec(path);
  if (pkg) return pkg[0];
  return path.startsWith("scripts/") ? "scripts/" : null;
}

export function repoTierDirs(root = ROOT) {
  const files = REPO_TIER_INCLUDE.flatMap((pattern) => globSync(pattern, { cwd: root }));
  return new Set(files.map(packageDirOf).filter(Boolean));
}

export function vitestArgs(base, changed, repoDirs) {
  const args = ["run", "--changed", base, "--passWithNoTests", "--project", "threads", "--project", "forks"];
  const touchesRepoTier = changed.some((path) => repoDirs.has(packageDirOf(path)));
  return touchesRepoTier ? [...args, "--project", "repo"] : args;
}

const gitLines = (args, cwd) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).split("\n").filter(Boolean);

/** The same set vitest --changed reads: committed since base, staged, and modified or untracked. */
export function changedFiles(base, cwd = ROOT) {
  return [
    ...gitLines(["diff", "--name-only", `${base}...HEAD`], cwd),
    ...gitLines(["diff", "--cached", "--name-only"], cwd),
    ...gitLines(["ls-files", "--other", "--modified", "--exclude-standard"], cwd),
  ];
}

function main() {
  const base = resolveBase(process.env, process.argv.slice(2));
  const args = vitestArgs(base, changedFiles(base), repoTierDirs());
  console.log(`test:affected: vitest ${args.join(" ")}`);
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
