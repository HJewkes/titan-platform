import { expect, it } from "vitest";
import { ATTESTATIONS_DIR, LEGACY_ATTESTATIONS_PATH, LOCK_PATH, readBaseAttestations, readPrNumber, resolveBase, runCheck } from "./step-closure-check.mjs";

const lock = (closure) => JSON.stringify({ "ci-wait": { closure, schemaHash: "schema-1", bump: 0 } });
const passing = () => ({ failures: [], notices: [] });
/** A working tree of `files`: `listDir` names a directory's direct entries, `readFile` throws for a path not there. */
function tree(files) {
  const readFile = (path) => {
    if (!(path in files)) throw new Error(`ENOENT: ${path}`);
    return files[path];
  };
  const listDir = (dir) => [...new Set(Object.keys(files).filter((path) => path.startsWith(`${dir}/`)).map((path) => path.slice(dir.length + 1).split("/")[0]))];
  return { readFile, listDir };
}

/** The tree's attestation files, one per PR, from rows grouped by their own `pr`. */
function fileRows(rows) {
  const files = {};
  for (const row of rows) files[`${ATTESTATIONS_DIR}/${row.pr}.json`] = JSON.stringify([...JSON.parse(files[`${ATTESTATIONS_DIR}/${row.pr}.json`] ?? "[]"), row]);
  return files;
}

const capture = () => {
  const seen = {};
  return { seen, check: (received) => Object.assign(seen, received) && passing() };
};

it("the check reads the base lock from origin/main, not the working tree", () => {
  const gitCalls = [];
  const git = (args) => {
    gitCalls.push(args.join(" "));
    return args[0] === "show" ? lock("base-closure") : "";
  };
  const { seen: input, check } = capture();

  runCheck({ git, ...tree({ [LOCK_PATH]: lock("head-closure") }), check, base: "origin/main" });

  expect(gitCalls).toContain(`show origin/main:${LOCK_PATH}`);
  expect(input.base["ci-wait"].closure).toBe("base-closure");
  expect(input.committed["ci-wait"].closure).toBe("head-closure");
});

it("a base with no lock yet hands the check no base", () => {
  const git = (args) => {
    if (args[0] === "show") throw new Error("path does not exist in origin/main");
    return "";
  };

  const { seen: input, check } = capture();

  runCheck({ git, ...tree({ [LOCK_PATH]: lock("head-closure") }), check, base: "origin/main" });

  expect(input.base).toBeUndefined();
});

const row = (step, closure, pr) => ({ step, closure, pr });
const CLOSURE_A = "aaaaaaaaaaaa0000000000000000";
const CLOSURE_B = "bbbbbbbbbbbb1111111111111111";

/** A git whose refs each hold their own attestation files, keyed `ref` to repo path to content. */
function gitWithRefs(filesByRef) {
  return (args) => {
    if (args[0] === "ls-tree") return Object.keys(filesByRef[args[2]] ?? {}).filter((path) => path.startsWith(args[3])).join("\n");
    if (args[0] !== "show") return "";
    const [ref, path] = args[1].split(":");
    if (path === LOCK_PATH) return lock("closure-1");
    const content = filesByRef[ref]?.[path];
    if (content === undefined) throw new Error(`path ${path} does not exist in ${ref}`);
    return content;
  };
}

function checkRows({ baseRows, headRows, prNumber, headFiles = fileRows(headRows) }) {
  const git = gitWithRefs({ "origin/main": fileRows(baseRows) });
  return runCheck({ git, ...tree({ [LOCK_PATH]: lock("closure-1"), ...headFiles }), check: passing, base: "origin/main", prNumber });
}

it("an added attestation row naming another PR fails", () => {
  const result = checkRows({ baseRows: [], headRows: [row("ci-wait", CLOSURE_A, 7)], prNumber: 8 });

  expect(result.failures).toEqual(["ci-wait@aaaaaaaaaaaa: an added attestation row names PR 7, not this PR #8"]);
});

it("an added row naming this PR passes", () => {
  const result = checkRows({ baseRows: [], headRows: [row("ci-wait", CLOSURE_A, 8)], prNumber: 8 });

  expect(result.failures).toEqual([]);
  expect(result.notices).toEqual(["attest required: ci-wait@aaaaaaaaaaaa"]);
});

it("with no pull_request event the PR check is skipped", () => {
  const pushEvent = JSON.stringify({ ref: "refs/heads/main" });
  const prNumber = readPrNumber({ GITHUB_EVENT_PATH: "/event.json" }, () => pushEvent);

  const result = checkRows({ baseRows: [], headRows: [row("ci-wait", CLOSURE_A, 7)], prNumber });

  expect(prNumber).toBeUndefined();
  expect(result.failures).toEqual([]);
  expect(result.notices).toEqual(["attest required: ci-wait@aaaaaaaaaaaa"]);
});

it("a row already on the base is never re-judged", () => {
  const old = row("ci-wait", CLOSURE_A, 3);

  const result = checkRows({ baseRows: [old], headRows: [old, row("pr-open", CLOSURE_B, 8)], prNumber: 8 });

  expect(result.failures).toEqual([]);
  expect(result.notices).toEqual(["attest required: pr-open@bbbbbbbbbbbb"]);
});

it("the PR number comes from the pull_request event payload", () => {
  const event = JSON.stringify({ pull_request: { number: 42 } });

  expect(readPrNumber({ GITHUB_EVENT_PATH: "/event.json" }, () => event)).toBe(42);
  expect(readPrNumber({}, () => event)).toBeUndefined();
});

const PARENT_PR = 7;
const CHILD_PR = 8;

function checkAgainstResolvedBase({ env, attestationsByRef, headRows }) {
  const byRef = Object.fromEntries(Object.entries(attestationsByRef).map(([ref, rows]) => [ref, fileRows(rows)]));
  const base = resolveBase([], env);
  return runCheck({ git: gitWithRefs(byRef), ...tree({ [LOCK_PATH]: lock("closure-1"), ...fileRows(headRows) }), check: passing, base, prNumber: CHILD_PR });
}

it("a PR stacked on a parent that added a row passes when judged against its own base", () => {
  const parentRow = row("ci-wait", CLOSURE_A, PARENT_PR);

  const result = checkAgainstResolvedBase({
    env: { GITHUB_BASE_REF: "parent-branch" },
    attestationsByRef: { "origin/parent-branch": [parentRow], "origin/main": [] },
    headRows: [parentRow],
  });

  expect(result.failures).toEqual([]);
});

it("a PR based on main still fails for a row naming another PR", () => {
  const result = checkAgainstResolvedBase({
    env: { GITHUB_BASE_REF: "main" },
    attestationsByRef: { "origin/main": [] },
    headRows: [row("ci-wait", CLOSURE_A, PARENT_PR)],
  });

  expect(result.failures).toEqual(["ci-wait@aaaaaaaaaaaa: an added attestation row names PR 7, not this PR #8"]);
});

it("the base is argv, then CLOSURE_BASE, then the PR base, then origin/main", () => {
  const env = { CLOSURE_BASE: "origin/env", GITHUB_BASE_REF: "pr-base" };

  expect(resolveBase(["origin/arg"], env)).toBe("origin/arg");
  expect(resolveBase([], env)).toBe("origin/env");
  expect(resolveBase([], { GITHUB_BASE_REF: "pr-base" })).toBe("origin/pr-base");
  expect(resolveBase([], {})).toBe("origin/main");
});

it("a row in a file named for another PR fails, so each PR writes only its own file", () => {
  const result = checkRows({ baseRows: [], headRows: [], prNumber: 8, headFiles: { [`${ATTESTATIONS_DIR}/9.json`]: JSON.stringify([row("ci-wait", CLOSURE_A, 8)]) } });

  expect(result.failures).toEqual([`${ATTESTATIONS_DIR}/9.json: a row names PR 8; it belongs in 8.json`]);
});

it("a file in the attestations directory that no PR could have written fails", () => {
  const result = checkRows({ baseRows: [], headRows: [], prNumber: 8, headFiles: { [`${ATTESTATIONS_DIR}/notes.json`]: "[]" } });

  expect(result.failures).toEqual([`${ATTESTATIONS_DIR}/notes.json: not a <pr>.json attestations file`]);
});

it("the retired single attestations file left in the tree fails", () => {
  const result = checkRows({ baseRows: [], headRows: [], prNumber: 8, headFiles: { [LEGACY_ATTESTATIONS_PATH]: "[]" } });

  expect(result.failures).toEqual([`${LEGACY_ATTESTATIONS_PATH} is retired; move its rows to ${ATTESTATIONS_DIR}/<pr>.json`]);
});

it("a base from before the per-PR files is read from its single file, so migrated rows are not added", () => {
  const old = [row("ci-wait", CLOSURE_A, 3), row("merge", CLOSURE_B, 4)];
  const git = gitWithRefs({ "origin/main": { [LEGACY_ATTESTATIONS_PATH]: JSON.stringify(old) } });

  expect(readBaseAttestations(git, "origin/main")).toEqual(old);
  const result = runCheck({ git, ...tree({ [LOCK_PATH]: lock("closure-1"), ...fileRows(old) }), check: passing, base: "origin/main", prNumber: 8 });
  expect(result).toEqual({ failures: [], notices: [] });
});
