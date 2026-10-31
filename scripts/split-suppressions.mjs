#!/usr/bin/env node
// Moves every entry of the root eslint baselines into each package's own file and deletes the root files (TP-4633).
// One command, so a branch that took main's root files in a merge can migrate them again.
// Usage: node scripts/split-suppressions.mjs
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TYPED_BASELINE, UNTYPED_BASELINE } from "./lint-units.mjs";
import { readWorkspace } from "./test-scope.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The workspace dir holding a repo-relative path; an entry outside every member is an error, never dropped. */
function ownerOf(file, dirs) {
  const dir = dirs.find((candidate) => file.startsWith(candidate));
  if (dir === undefined) throw new Error(`no workspace package holds ${file}`);
  return dir;
}

/** Groups a baseline's entries by owning dir, keeping each entry as written. */
export function splitBaseline(baseline, memberDirs) {
  const dirs = [...memberDirs].sort((a, b) => b.length - a.length);
  const split = new Map();
  for (const [file, rules] of Object.entries(baseline)) {
    const dir = ownerOf(file, dirs);
    split.set(dir, { ...split.get(dir), [file]: rules });
  }
  return split;
}

export const violationCount = (baseline) => Object.values(baseline).flatMap((rules) => Object.values(rules)).reduce((sum, rule) => sum + rule.count, 0);

const sortedKeys = (record) => Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : 1)));

/** Key order and spacing as eslint's own --prune-suppressions writes them, so a prune diffs only what it removed. */
export function serialized(baseline) {
  const sorted = Object.entries(sortedKeys(baseline)).map(([file, rules]) => [file, sortedKeys(rules)]);
  return JSON.stringify(Object.fromEntries(sorted), null, 2);
}

/** The root file is the truth, so a package it no longer names loses any file an earlier run wrote. */
function migrate(root, name, memberDirs) {
  const rootFile = join(root, name);
  if (!existsSync(rootFile)) return;
  const baseline = JSON.parse(readFileSync(rootFile, "utf8"));
  const split = splitBaseline(baseline, memberDirs);
  let moved = 0;
  for (const dir of memberDirs) {
    const path = join(root, dir, name);
    const entries = split.get(dir);
    if (entries === undefined) {
      rmSync(path, { force: true });
      continue;
    }
    writeFileSync(path, serialized(entries));
    moved += violationCount(entries);
  }
  rmSync(rootFile);
  console.log(`${name}: ${Object.keys(baseline).length} files, ${violationCount(baseline)} violations in, ${moved} moved`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const memberDirs = readWorkspace(ROOT).map((member) => member.dir);
  for (const name of [UNTYPED_BASELINE, TYPED_BASELINE]) migrate(ROOT, name, memberDirs);
}
