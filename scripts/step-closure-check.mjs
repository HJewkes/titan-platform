#!/usr/bin/env node
// `pnpm registry:closure`: a factory fact step whose import closure changed against the base must change its schema
// hash or bump, or carry an attestation for the new closure (TP-3106 S6). `--write` refreshes the committed lock.
// The closure walk is TypeScript, so this runs the factory's built products/factory/dist/registry/closure-main.js: build first.
// Usage: node scripts/step-closure-check.mjs [--write] [base]   (base: argv, then CLOSURE_BASE, then origin/main)
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const LOCK_PATH = "products/factory/src/registry/closure.lock.json";
export const ATTESTATIONS_PATH = "products/factory/src/registry/attestations.json";
const CLOSURE_MAIN = join(ROOT, "products/factory/dist/registry/closure-main.js");
const DEFAULT_BASE = "origin/main";

/** The base's committed lock, or undefined when the base has none yet. A base ref that does not exist throws. */
export function readBaseLock(git, base) {
  git(["rev-parse", "--verify", `${base}^{commit}`]);
  try {
    return JSON.parse(git(["show", `${base}:${LOCK_PATH}`]));
  } catch {
    return undefined;
  }
}

/** Base from git, the committed lock and attestations from the working tree; `check` computes and judges. */
export function runCheck({ git, readFile, check, base }) {
  return check({ base: readBaseLock(git, base), committed: JSON.parse(readFile(LOCK_PATH)), attestations: JSON.parse(readFile(ATTESTATIONS_PATH)) });
}

function closureMain(args, input) {
  if (!existsSync(CLOSURE_MAIN)) throw new Error(`${CLOSURE_MAIN} is missing; run pnpm build first`);
  return execFileSync(process.execPath, [CLOSURE_MAIN, ROOT, ...args], { encoding: "utf8", input });
}

function main(argv = process.argv.slice(2), env = process.env) {
  if (argv.includes("--write")) {
    writeFileSync(join(ROOT, LOCK_PATH), closureMain(["--print"]));
    return;
  }
  const git = (args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const readFile = (path) => readFileSync(join(ROOT, path), "utf8");
  const check = (input) => JSON.parse(closureMain([], JSON.stringify(input)));
  const { failures, notices } = runCheck({ git, readFile, check, base: argv[0] || env.CLOSURE_BASE || DEFAULT_BASE });
  for (const notice of notices) console.log(`registry:closure: ${notice}`);
  for (const failure of failures) console.error(`registry:closure: ${failure}`);
  if (failures.length > 0) process.exitCode = 1;
  else console.log("registry:closure: every fact step's closure is versioned or attested");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
