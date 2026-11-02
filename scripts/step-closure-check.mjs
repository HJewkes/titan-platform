#!/usr/bin/env node
// `pnpm registry:closure`: a factory fact step whose import closure changed against the base must change its schema
// hash or bump, or carry an attestation for the new closure (TP-3106 S6). `--write` refreshes the committed lock.
// The closure walk is TypeScript, so this runs the factory's built products/factory/dist/registry/closure-main.js: build first.
// On a pull request, an attestation row the base lacks must name that PR, so one PR cannot attest for another (TP-3110 S5).
// Usage: node scripts/step-closure-check.mjs [--write] [base]   (base: argv, CLOSURE_BASE, origin/$GITHUB_BASE_REF on a PR, then origin/main)
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

/** The base's attestation rows, or none when the base has no attestations file. */
export function readBaseAttestations(git, base) {
  try {
    return JSON.parse(git(["show", `${base}:${ATTESTATIONS_PATH}`]));
  } catch {
    return [];
  }
}

/** The pull request number from the Actions event payload; undefined off a pull request. */
export function readPrNumber(env, readFile) {
  if (!env.GITHUB_EVENT_PATH) return undefined;
  return JSON.parse(readFile(env.GITHUB_EVENT_PATH)).pull_request?.number;
}

const sameRow = (a, b) => a.step === b.step && a.closure === b.closure && a.pr === b.pr;

/** Rows the working tree adds over the base: each must name this PR. Skipped when there is no PR. */
export function judgeAddedRows(baseRows, rows, prNumber) {
  const added = rows.filter((row) => !baseRows.some((old) => sameRow(old, row)));
  const label = (row) => `${row.step}@${String(row.closure).slice(0, 12)}`;
  const notices = added.map((row) => `attest required: ${label(row)}`);
  if (prNumber === undefined) return { failures: [], notices };
  const failures = added.filter((row) => row.pr !== prNumber).map((row) => `${label(row)}: an added attestation row names PR ${row.pr}, not this PR #${prNumber}`);
  return { failures, notices };
}

/** Base from git, the committed lock and attestations from the working tree; `check` computes and judges. */
export function runCheck({ git, readFile, check, base, prNumber }) {
  const attestations = JSON.parse(readFile(ATTESTATIONS_PATH));
  const result = check({ base: readBaseLock(git, base), committed: JSON.parse(readFile(LOCK_PATH)), attestations });
  const added = judgeAddedRows(readBaseAttestations(git, base), attestations, prNumber);
  return { ...result, failures: [...result.failures, ...added.failures], notices: [...result.notices, ...added.notices] };
}

/** argv, then CLOSURE_BASE, then the pull request's base branch (so a stacked PR is judged against its parent), then origin/main. */
export function resolveBase(argv, env) {
  const prBase = env.GITHUB_BASE_REF ? `origin/${env.GITHUB_BASE_REF}` : undefined;
  return argv[0] || env.CLOSURE_BASE || prBase || DEFAULT_BASE;
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
  const prNumber = readPrNumber(env, (path) => readFileSync(path, "utf8"));
  const { failures, notices } = runCheck({ git, readFile, check, base: resolveBase(argv, env), prNumber });
  for (const notice of notices) console.log(`registry:closure: ${notice}`);
  for (const failure of failures) console.error(`registry:closure: ${failure}`);
  if (failures.length > 0) process.exitCode = 1;
  else console.log("registry:closure: every fact step's closure is versioned or attested");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
