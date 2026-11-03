#!/usr/bin/env node
// The git merge driver for products/factory/src/registry/closure.lock.json (TP-4745), named in .gitattributes.
// It merges the lock step by step, so a merge where each side moved a different step's row never conflicts. Where both
// sides moved the same step, neither row is right: the merged closure is new. It keeps ours and exits 0, and the
// stale-lock failure of `pnpm registry:closure` then asks for `pnpm build` and `pnpm registry:closure --write`, so
// the lock is regenerated rather than hand-merged.
// Usage: git runs `node scripts/closure-lock-merge.mjs %O %A %B` and reads the merge from %A.
//        `node scripts/closure-lock-merge.mjs --install` registers the driver in this clone's git config (pnpm prepare).
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const DRIVER = "closure-lock";
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Each step's row from the side that moved it; a step both sides moved differently keeps ours and is named diverged. */
export function mergeLocks(base, ours, theirs) {
  const steps = [...new Set([...Object.keys(base), ...Object.keys(ours), ...Object.keys(theirs)])].sort();
  const diverged = [];
  const merged = {};
  for (const step of steps) {
    const [before, mine, other] = [base[step], ours[step], theirs[step]];
    const row = same(mine, before) ? other : mine;
    if (!same(mine, before) && !same(other, before) && !same(mine, other)) diverged.push(step);
    if (row !== undefined) merged[step] = row;
  }
  return { lock: merged, diverged };
}

/** Writes the driver into `.git/config`; a clone that cannot take it merges the lock as text, as before. */
function install() {
  const git = (args) => execFileSync("git", args, { stdio: ["ignore", "ignore", "pipe"] });
  try {
    git(["config", `merge.${DRIVER}.name`, "closure.lock.json, merged per step"]);
    git(["config", `merge.${DRIVER}.driver`, "node scripts/closure-lock-merge.mjs %O %A %B"]);
  } catch {
    console.warn(`closure-lock-merge: merge.${DRIVER} not registered; closure.lock.json merges as text`);
  }
}

function main([first, ours, theirs]) {
  if (first === "--install") return install();
  const read = (path) => JSON.parse(readFileSync(path, "utf8"));
  const { lock, diverged } = mergeLocks(read(first), read(ours), read(theirs));
  writeFileSync(ours, `${JSON.stringify(lock, null, 2)}\n`);
  for (const step of diverged) console.error(`closure-lock-merge: ${step} moved on both sides; run pnpm build, then pnpm registry:closure --write`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
