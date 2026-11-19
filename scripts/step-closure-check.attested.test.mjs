import { expect, it } from "vitest";
import { ATTESTATIONS_DIR, LOCK_PATH, runCheck } from "./step-closure-check.mjs";

// An attestation row claims its step unchanged at the row's closure, so an added one is judged against the lock (TP-6480).
const BASE_LOCK = JSON.stringify({ "ci-wait": { closure: "closure-1", schemaHash: "schema-1", bump: 0 } });
const passing = () => ({ failures: [], notices: [] });
const row = (step, closure, pr) => ({ step, closure, pr });
const CLOSURE_A = "aaaaaaaaaaaa0000000000000000";
const CLOSURE_B = "bbbbbbbbbbbb1111111111111111";

/** One `<pr>.json` per PR, from rows grouped by their own `pr`. */
function fileRows(rows) {
  const files = {};
  for (const r of rows) files[`${ATTESTATIONS_DIR}/${r.pr}.json`] = JSON.stringify([...JSON.parse(files[`${ATTESTATIONS_DIR}/${r.pr}.json`] ?? "[]"), r]);
  return files;
}

/** A working tree of `files`: `listDir` names a directory's direct entries, `readFile` throws for a path not there. */
function tree(files) {
  const readFile = (path) => {
    if (!(path in files)) throw new Error(`ENOENT: ${path}`);
    return files[path];
  };
  const listDir = (dir) => [...new Set(Object.keys(files).filter((path) => path.startsWith(`${dir}/`)).map((path) => path.slice(dir.length + 1).split("/")[0]))];
  return { readFile, listDir };
}

/** A git whose one base ref holds `files` beside the base lock. */
function gitAtBase(files) {
  return (args) => {
    if (args[0] === "ls-tree") return Object.keys(files).filter((path) => path.startsWith(args[3])).join("\n");
    if (args[0] !== "show") return "";
    const path = args[1].split(":")[1];
    if (path === LOCK_PATH) return BASE_LOCK;
    if (!(path in files)) throw new Error(`path ${path} does not exist`);
    return files[path];
  };
}

/** The committed lock with each row's step at the row's closure. */
function lockOf(rows, version = { schemaHash: "schema-1", bump: 0 }) {
  const steps = { "ci-wait": { closure: "closure-1", ...version } };
  for (const { step, closure } of rows) steps[step] = { closure, ...version };
  return JSON.stringify(steps);
}

function checkRows({ baseRows, headRows, prNumber, headLock }) {
  return runCheck({ git: gitAtBase(fileRows(baseRows)), ...tree({ [LOCK_PATH]: headLock, ...fileRows(headRows) }), check: passing, base: "origin/main", prNumber });
}

it("an added row attesting the closure its step has in the committed lock passes", () => {
  const result = checkRows({ baseRows: [], headRows: [row("ci-wait", CLOSURE_A, 8)], prNumber: 8, headLock: lockOf([row("ci-wait", CLOSURE_A, 8)]) });

  expect(result.failures).toEqual([]);
});

it("an added row attesting a step unchanged at a closure the step has moved off fails", () => {
  const result = checkRows({ baseRows: [], headRows: [row("ci-wait", CLOSURE_A, 8)], prNumber: 8, headLock: lockOf([row("ci-wait", CLOSURE_B, 8)]) });

  expect(result.failures).toEqual([`ci-wait@aaaaaaaaaaaa: attests ci-wait unchanged at a closure it does not have; its closure is ${CLOSURE_B}, so attest that or drop the row`]);
});

it("an added row attesting a step unchanged while the branch bumps its version fails", () => {
  const bumped = lockOf([row("ci-wait", CLOSURE_A, 8)], { schemaHash: "schema-1", bump: 1 });

  const result = checkRows({ baseRows: [], headRows: [row("ci-wait", CLOSURE_A, 8)], prNumber: 8, headLock: bumped });

  expect(result.failures).toEqual(["ci-wait@aaaaaaaaaaaa: attests ci-wait unchanged, but this branch changes its version; drop the row"]);
});

it("an added row attesting a step the lock does not have fails", () => {
  const result = checkRows({ baseRows: [], headRows: [row("no-such-step", CLOSURE_A, 8)], prNumber: 8, headLock: lockOf([]) });

  expect(result.failures).toEqual([`no-such-step@aaaaaaaaaaaa: attests no-such-step, which is not a fact step of ${LOCK_PATH}`]);
});

it("a base row whose closure the step has since left is not re-judged", () => {
  const old = row("ci-wait", CLOSURE_A, 3);

  const result = checkRows({ baseRows: [old], headRows: [old], prNumber: undefined, headLock: lockOf([row("ci-wait", CLOSURE_B, 8)]) });

  expect(result.failures).toEqual([]);
});
