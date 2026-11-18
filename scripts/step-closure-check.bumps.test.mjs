import { expect, it } from "vitest";
import { BUMPS_DIR, LOCK_PATH, runCheck } from "./step-closure-check.mjs";

const LOCK = JSON.stringify({ "ci-wait": { closure: "closure-1", schemaHash: "schema-1", bump: 0 } });
const passing = () => ({ failures: [], notices: [] });
const bump = (step, pr) => ({ step, pr });

/** One `<pr>.json` per PR, from rows grouped by their own `pr`. */
function bumpFiles(rows) {
  const files = {};
  for (const row of rows) files[`${BUMPS_DIR}/${row.pr}.json`] = JSON.stringify([...JSON.parse(files[`${BUMPS_DIR}/${row.pr}.json`] ?? "[]"), row]);
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

/** A git whose one base ref holds `files` beside the lock. */
function gitAtBase(files) {
  return (args) => {
    if (args[0] === "ls-tree") return Object.keys(files).filter((path) => path.startsWith(args[3])).join("\n");
    if (args[0] !== "show") return "";
    const path = args[1].split(":")[1];
    if (path === LOCK_PATH) return LOCK;
    if (!(path in files)) throw new Error(`path ${path} does not exist`);
    return files[path];
  };
}

function checkBumps({ baseRows, headFiles, prNumber = 8 }) {
  return runCheck({ git: gitAtBase(bumpFiles(baseRows)), ...tree({ [LOCK_PATH]: LOCK, ...headFiles }), check: passing, base: "origin/main", prNumber });
}

it("a PR's bump row passes after another PR's row for the same step lands", () => {
  const result = checkBumps({ baseRows: [bump("ci-wait", 7)], headFiles: bumpFiles([bump("ci-wait", 7), bump("ci-wait", 8)]) });

  expect(result.failures).toEqual([]);
});

it("an added bump row naming another PR fails", () => {
  const result = checkBumps({ baseRows: [], headFiles: bumpFiles([bump("ci-wait", 7)]) });

  expect(result.failures).toEqual(["ci-wait: an added bump row names PR 7, not this PR #8"]);
});

it("a removed bump row fails, so lowering the sum never passes as a version change", () => {
  const result = checkBumps({ baseRows: [bump("ci-wait", 7)], headFiles: {} });

  expect(result.failures).toEqual(["ci-wait: the bump row of PR 7 was removed; bump rows are append-only"]);
});

it("a bump row naming no fact step fails", () => {
  const result = checkBumps({ baseRows: [], headFiles: bumpFiles([bump("no-such-step", 8)]) });

  expect(result.failures).toEqual([`${BUMPS_DIR}/8.json: no-such-step is not a fact step`]);
});

it("a bump row in a file named for another PR fails", () => {
  const result = checkBumps({ baseRows: [], headFiles: { [`${BUMPS_DIR}/9.json`]: JSON.stringify([bump("ci-wait", 8)]) } });

  expect(result.failures).toEqual([`${BUMPS_DIR}/9.json: a row names PR 8; it belongs in 8.json`]);
});
