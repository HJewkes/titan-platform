#!/usr/bin/env node
// `pnpm registry:closure`: a factory fact step whose import closure changed against the base must change its schema
// hash or bump, or carry an attestation for the new closure (TP-3106 S6). `--write` refreshes the committed lock.
// The closure walk is TypeScript, so this runs the factory's built products/factory/dist/registry/closure-main.js: build first.
// On a pull request, an attestation row the base lacks must name that PR, so one PR cannot attest for another (TP-3110 S5),
// or a parent PR the branch is stacked on, so a child never deletes or copies its parent's file (TP-4840).
// Rows live one file per PR, attestations/<pr>.json, so two PRs adding rows never conflict (TP-4745); a row's pr names its file.
// Version bumps are rows too, bumps/<pr>.json of { step, pr }, summed into the step's bump by the registry, so two PRs
// bumping one step both count when either lands (TP-5705). Bump rows are append-only and an added one must name this PR.
// Usage: node scripts/step-closure-check.mjs [--write] [base]   (base: argv, CLOSURE_BASE, origin/$GITHUB_BASE_REF on a PR, then origin/main)
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const LOCK_PATH = "products/factory/src/registry/closure.lock.json";
export const ATTESTATIONS_DIR = "products/factory/src/registry/attestations";
export const BUMPS_DIR = "products/factory/src/registry/bumps";
/** The one file every PR appended to before TP-4745; read only at a base that predates the directory, refused in the tree. */
export const LEGACY_ATTESTATIONS_PATH = "products/factory/src/registry/attestations.json";
const PR_FILE = /^([1-9][0-9]*)\.json$/;
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

/** The rows of each named `<pr>.json` in `dir`, with a failure for a name no PR file could have or a row naming another PR. */
export function rowsOfFiles(names, read, dir = ATTESTATIONS_DIR) {
  const rows = [];
  const failures = [];
  for (const name of names) {
    const pr = Number(PR_FILE.exec(name)?.[1]);
    if (Number.isNaN(pr)) failures.push(`${dir}/${name}: not a <pr>.json ${dir.split("/").at(-1)} file`);
    if (Number.isNaN(pr)) continue;
    const fileRows = JSON.parse(read(`${dir}/${name}`));
    rows.push(...fileRows);
    failures.push(...fileRows.filter((row) => row.pr !== pr).map((row) => `${dir}/${name}: a row names PR ${row.pr}; it belongs in ${row.pr}.json`));
  }
  return { rows, failures };
}

/** The rows of the base's PR files in `dir`, undefined when it has none; throws when the base cannot be read. */
function readBaseRows(git, base, dir) {
  const names = git(["ls-tree", "--name-only", base, `${dir}/`]).split("\n").filter(Boolean).map((path) => path.slice(dir.length + 1));
  return names.length > 0 ? rowsOfFiles(names, (path) => git(["show", `${base}:${path}`]), dir).rows : undefined;
}

/** The base's attestation rows: its PR files, else its legacy file, else none. */
export function readBaseAttestations(git, base) {
  try {
    return readBaseRows(git, base, ATTESTATIONS_DIR) ?? JSON.parse(git(["show", `${base}:${LEGACY_ATTESTATIONS_PATH}`]));
  } catch {
    return [];
  }
}

/** The base's bump rows; an unreadable base has none, so every tree row is judged as added. */
function readBaseBumps(git, base) {
  try {
    return readBaseRows(git, base, BUMPS_DIR) ?? [];
  } catch {
    return [];
  }
}

/** The working tree's rows from its PR files; a legacy file left in the tree fails, as a PR appending to it conflicts again. */
export function readTreeAttestations(listDir, readFile) {
  const { rows, failures } = rowsOfFiles(listDir(ATTESTATIONS_DIR), readFile);
  const legacy = listDir(dirname(LEGACY_ATTESTATIONS_PATH)).includes("attestations.json");
  return { rows, failures: legacy ? [`${LEGACY_ATTESTATIONS_PATH} is retired; move its rows to ${ATTESTATIONS_DIR}/<pr>.json`, ...failures] : failures };
}

/** The pull request number from the Actions event payload; undefined off a pull request. */
export function readPrNumber(env, readFile) {
  if (!env.GITHUB_EVENT_PATH) return undefined;
  return JSON.parse(readFile(env.GITHUB_EVENT_PATH)).pull_request?.number;
}

const sameRow = (a, b) => a.step === b.step && a.closure === b.closure && a.pr === b.pr;

/**
 * Whether PR `pr` is a parent this branch is stacked on: every commit in base..HEAD that touched `<pr>.json` is in
 * that PR's own head, fetched from GitHub's refs/pull/<pr>/head. Resolved from git, not the PR body, so it is the
 * same on every run; a commit of this branch's own that writes the file, or a fetch that fails, judges it foreign.
 */
export function isStackedParent(git, base, pr, dir = ATTESTATIONS_DIR) {
  const parentHead = `refs/closure-parent/${pr}`;
  try {
    git(["fetch", "--quiet", "--no-tags", "origin", `+refs/pull/${pr}/head:${parentHead}`]);
    const commits = git(["log", "--format=%H", `${base}..HEAD`, "--", `${dir}/${pr}.json`]).split("\n").filter(Boolean);
    for (const commit of commits) git(["merge-base", "--is-ancestor", commit, parentHead]);
    return commits.length > 0;
  } catch {
    return false;
  }
}

/** Rows the working tree adds over the base: each must name this PR or a stacked parent's. Skipped when there is no PR. */
export function judgeAddedRows(baseRows, rows, prNumber, isParent = () => false) {
  const added = rows.filter((row) => !baseRows.some((old) => sameRow(old, row)));
  const label = (row) => `${row.step}@${String(row.closure).slice(0, 12)}`;
  const notices = added.map((row) => `attest required: ${label(row)}`);
  if (prNumber === undefined) return { failures: [], notices };
  const foreign = added.filter((row) => row.pr !== prNumber);
  const parents = new Set([...new Set(foreign.map((row) => row.pr))].filter((pr) => isParent(pr)));
  const failures = foreign.filter((row) => !parents.has(row.pr)).map((row) => `${label(row)}: an added attestation row names PR ${row.pr}, not this PR #${prNumber}`);
  return { failures, notices: [...notices, ...[...parents].map((pr) => `rows of #${pr} accepted: this branch is stacked on it`)] };
}

const sameBump = (a, b) => a.step === b.step && a.pr === b.pr;

/**
 * A base bump row gone from the tree would lower the sum and pass as a version change, so rows are append-only; a row
 * must name a fact step of the lock; an added row must name this PR or a stacked parent's, as attestations must.
 */
function judgeBumps({ baseRows, rows, steps, prNumber, isParent = () => false }) {
  const removed = baseRows.filter((old) => !rows.some((row) => sameBump(row, old))).map((old) => `${old.step}: the bump row of PR ${old.pr} was removed; bump rows are append-only`);
  const unknown = rows.filter((row) => !steps.includes(row.step)).map((row) => `${BUMPS_DIR}/${row.pr}.json: ${row.step} is not a fact step`);
  const added = rows.filter((row) => !baseRows.some((old) => sameBump(old, row)));
  const foreign = prNumber === undefined ? [] : added.filter((row) => row.pr !== prNumber && !isParent(row.pr));
  return [...removed, ...unknown, ...foreign.map((row) => `${row.step}: an added bump row names PR ${row.pr}, not this PR #${prNumber}`)];
}

/** Base from git, the committed lock, attestation and bump files from the working tree; `check` computes and judges. */
export function runCheck({ git, readFile, listDir, check, base, prNumber }) {
  const tree = readTreeAttestations(listDir, readFile);
  const committed = JSON.parse(readFile(LOCK_PATH));
  const result = check({ base: readBaseLock(git, base), committed, attestations: tree.rows });
  const added = judgeAddedRows(readBaseAttestations(git, base), tree.rows, prNumber, (pr) => isStackedParent(git, base, pr));
  const bumps = rowsOfFiles(listDir(BUMPS_DIR), readFile, BUMPS_DIR);
  const isBumpParent = (pr) => isStackedParent(git, base, pr, BUMPS_DIR);
  const bumpFailures = judgeBumps({ baseRows: readBaseBumps(git, base), rows: bumps.rows, steps: Object.keys(committed), prNumber, isParent: isBumpParent });
  const failures = [...result.failures, ...tree.failures, ...added.failures, ...bumps.failures, ...bumpFailures];
  return { ...result, failures, notices: [...result.notices, ...added.notices] };
}

/** Whether HEAD is a merge commit with two parents, as GitHub builds refs/pull/<n>/merge; decided from git's structure alone. */
export function isPullRequestMergeCommit(git, env) {
  if (env.GITHUB_EVENT_NAME !== "pull_request") return false;
  try {
    return git(["rev-list", "--parents", "-n", "1", "HEAD"]).trim().split(" ").length === 3;
  } catch {
    return false;
  }
}

/**
 * argv, then CLOSURE_BASE, then the first parent of a pull request's merge commit (the base GitHub built it on, which a
 * later move of the base branch cannot change), then the pull request's base branch (so a stacked PR is judged against
 * its parent), then origin/main.
 */
export function resolveBase(argv, env, git = () => "") {
  const prBase = env.GITHUB_BASE_REF ? `origin/${env.GITHUB_BASE_REF}` : undefined;
  const mergeBase = isPullRequestMergeCommit(git, env) ? "HEAD^1" : undefined;
  return argv[0] || env.CLOSURE_BASE || mergeBase || prBase || DEFAULT_BASE;
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
  const listDir = (path) => (existsSync(join(ROOT, path)) ? readdirSync(join(ROOT, path)) : []);
  const check = (input) => JSON.parse(closureMain([], JSON.stringify(input)));
  const prNumber = readPrNumber(env, (path) => readFileSync(path, "utf8"));
  const { failures, notices } = runCheck({ git, readFile, listDir, check, base: resolveBase(argv, env, git), prNumber });
  for (const notice of notices) console.log(`registry:closure: ${notice}`);
  for (const failure of failures) console.error(`registry:closure: ${failure}`);
  if (failures.length > 0) process.exitCode = 1;
  else console.log("registry:closure: every fact step's closure is versioned or attested");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
