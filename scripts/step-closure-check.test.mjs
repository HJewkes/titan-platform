import { expect, it } from "vitest";
import { ATTESTATIONS_PATH, LOCK_PATH, readPrNumber, resolveBase, runCheck } from "./step-closure-check.mjs";

const lock = (closure) => JSON.stringify({ "ci-wait": { closure, schemaHash: "schema-1", bump: 0 } });
const passing = () => ({ failures: [], notices: [] });
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
  const files = { [LOCK_PATH]: lock("head-closure"), [ATTESTATIONS_PATH]: "[]" };

  const { seen: input, check } = capture();

  runCheck({ git, readFile: (path) => files[path], check, base: "origin/main" });

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

  runCheck({ git, readFile: (path) => (path === LOCK_PATH ? lock("head-closure") : "[]"), check, base: "origin/main" });

  expect(input.base).toBeUndefined();
});

const row = (step, closure, pr) => ({ step, closure, pr });
const CLOSURE_A = "aaaaaaaaaaaa0000000000000000";
const CLOSURE_B = "bbbbbbbbbbbb1111111111111111";

function checkRows({ baseRows, headRows, prNumber }) {
  const git = (args) => (args[0] === "show" && args[1].endsWith(ATTESTATIONS_PATH) ? JSON.stringify(baseRows) : lock("closure-1"));
  const files = { [LOCK_PATH]: lock("closure-1"), [ATTESTATIONS_PATH]: JSON.stringify(headRows) };
  return runCheck({ git, readFile: (path) => files[path], check: passing, base: "origin/main", prNumber });
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

function gitWithRefs(attestationsByRef) {
  return (args) => {
    if (args[0] !== "show") return "";
    const ref = args[1].split(":")[0];
    return args[1].endsWith(ATTESTATIONS_PATH) ? JSON.stringify(attestationsByRef[ref]) : lock("closure-1");
  };
}

function checkAgainstResolvedBase({ env, attestationsByRef, headRows }) {
  const files = { [LOCK_PATH]: lock("closure-1"), [ATTESTATIONS_PATH]: JSON.stringify(headRows) };
  const base = resolveBase([], env);
  return runCheck({ git: gitWithRefs(attestationsByRef), readFile: (path) => files[path], check: passing, base, prNumber: CHILD_PR });
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
